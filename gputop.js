"use strict";

//# sourceURL=gputop.js
// https://google.github.io/styleguide/javascriptguide.xml

/*
 * GPU Top
 *
 * Copyright (C) 2015-2016 Intel Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var is_nodejs = false;

if (typeof module !== 'undefined' && module.exports) {

    var WebSocket = require('ws');
    var ProtoBuf = require("protobufjs");
    var fs = require('fs');
    var jsdom = require('jsdom');
    var $ = require('jquery')(jsdom.jsdom().defaultView);
    var path = require('path');

    var cc = undefined;

    /* For unit testing we support running node.js tools with the Emscripten
     * compiled webc code, to cover more code in common with the web ui...
     */
    if (process.env.GPUTOP_NODE_USE_WEBC !== undefined) {
        cc = require("./gputop-web.js");
        cc.gputop_singleton = undefined;
    } else {
        cc = require("gputop-client-c");
        cc.gputop_singleton = undefined;

        /* For code compatibility with using the Emscripten compiled bindings... */
        cc.ALLOC_STACK = 0;
        cc.Runtime = { stackSave: function() { return 0; },
                       stackRestore: function(sp) {} };
        cc.allocate = function (data, type, where) { return data; };
        cc.intArrayFromString = function (str) { return str; };

        var client_data_path = require.resolve("gputop-data");
        client_data_path = path.resolve(client_data_path, "..");
    }

    var install_prefix = __dirname;

    is_nodejs = true;
} else {
    var cc = undefined;

    ProtoBuf = dcodeIO.ProtoBuf;
    var $ = window.jQuery;
}

function get_file(filename, load_callback, error_callback) {
    if (is_nodejs) {
        var full_path = path.join(client_data_path, filename);

        fs.readFile(full_path, 'utf8', (err, data) => {
            if (err)
                error_callback(err);
            else
                load_callback(data);
        });
    } else {
        var req = new XMLHttpRequest();
        req.open('GET', filename);
        req.onload = function () { load_callback(req.responseText); };
        req.onerror = error_callback;
        req.send();
    }
}

function Counter (metricParent) {

    this.metric = metricParent;

    /* Index into metric.cc_counters_, understood by gputop-web.c code */
    this.cc_counter_id_ = -1;
    this.name = '';
    this.symbol_name = '';
    this.supported_ = false;
    this.xml_ = "<xml/>";

    this.latest_value =  0;
    this.latest_max =  0;
    this.latest_duration = 0; /* how long were raw counters aggregated before
                               * calculating latest_value. (so the value can
                               * be scaled into a per-second value) */

    /* Not all counters have a constant or equation for the maximum
     * and so we simply derive a maximum based on the largest value
     * we've seen */
    this.inferred_max = 0;

    this.updates = [];
    this.units = '';

    /* whether append_counter_data() should really append to counter.updates[] */
    this.record_data = false;

    this.eq_xml = ""; // mathml equation
    this.max_eq_xml = ""; // mathml max equation

    this.duration_dependent = true;
    this.units_scale = 1; // default value
}

Counter.prototype.append_counter_data = function (start_timestamp, end_timestamp,
                                                  max, value, reason) {
    var duration = end_timestamp - start_timestamp;
    value *= this.units_scale;
    max *= this.units_scale;
    if (this.duration_dependent && (duration != 0)) {
        var per_sec_scale = 1000000000 / duration;
        value *= per_sec_scale;
        max *= per_sec_scale;
    }
    if (this.record_data) {
        this.updates.push([start_timestamp, end_timestamp, value, max, reason]);
        if (this.updates.length > 2000) {
            console.warn("Discarding old counter update (> 2000 updates old)");
            this.updates.shift();
        }
    }

    if (this.latest_value != value ||
        this.latest_max != max)
    {
        this.latest_value = value;
        this.latest_max = max;
        this.latest_duration = duration;

        if (value > this.inferred_max)
            this.inferred_max = value;
        if (max > this.inferred_max)
            this.inferred_max = max;
    }
}

function Metric (gputopParent) {
    this.gputop = gputopParent; /* yay for mark-sweep */

    this.name = "not loaded";
    this.symbol_name = "UnInitialized";
    this.chipset_ = "not loaded";

    this.guid_ = "undefined";
    this.metric_set_index_ = 0; //index into gputop.metrics[]

    this.xml_ = "<xml/>";
    this.supported_ = false;
    this.counters_ = [];     /* All possible counters associated with this metric
                              * set (not necessarily all supported by the current
                              * system */
    this.cc_counters = []; /* Counters applicable to this system, supported via
                              * gputop-web.c */
    this.counters_map_ = {}; // Map of counters by with symbol_name

    this.open_config = undefined;
    this.server_handle = 0;
    this.cc_stream_ptr_ = 0;

    // Aggregation period
    this.period_ns_ = 1000000000;

    this.history = []; // buffer used when query is paused.
    this.history_index = 0;
    this.history_size = 0;
}

Metric.prototype.find_counter_by_name = function(symbol_name) {
    return this.counters_map_[symbol_name];
}

/* FIXME: some of this should be handled in the Counter constructor */
Metric.prototype.add_counter = function(counter) {
    var symbol_name = counter.symbol_name;

    var sp = cc.Runtime.stackSave();

    var counter_idx = cc._gputop_cc_get_counter_id(String_pointerify_on_stack(this.guid_),
                                                   String_pointerify_on_stack(symbol_name));

    cc.Runtime.stackRestore(sp);

    counter.cc_counter_id_ = counter_idx;
    if (counter_idx != -1) {
        counter.supported_ = true;
        this.gputop.log('  Added available counter ' + counter_idx + ": " + symbol_name);
        this.cc_counters[counter_idx] = counter;
    } else {
        this.gputop.log('  Not adding unavailable counter:' + symbol_name);
    }

    this.counters_map_[symbol_name] = counter;
    this.counters_.push(counter);
}

Metric.prototype.set_aggregation_period = function(period_ns) {
    console.assert(typeof period_ns === 'number', "Need to pass Number to set_aggregation_period");

    this.period_ns_ = period_ns;

    if (this.cc_stream_ptr_)
        cc._gputop_cc_update_stream_period(this.cc_stream_ptr_, period_ns);
}

Metric.prototype.clear_metric_data = function() {

    cc._gputop_cc_reset_accumulator(this.cc_stream_ptr_);

    for (var i = 0; i < this.cc_counters.length; i++) {
        var counter = this.cc_counters[i];
        counter.updates = [];
    }
}

Metric.prototype.replay_buffer = function() {
    this.clear_metric_data();

    for (var i = 0; i < this.history.length; i++) {
        var data = this.history[i];

        var sp = cc.Runtime.stackSave();

        var stack_data = cc.allocate(data, 'i8', cc.ALLOC_STACK);

        cc._gputop_cc_handle_i915_perf_message(this.cc_stream_ptr_,
                                               stack_data,
                                               data.length);
        cc.Runtime.stackRestore(sp);
    }
}

Metric.prototype.set_paused = function(paused) {

    if (this.stream === undefined) {
        this.gputop.log("Can't change pause state of OA metric without a stream", this.gputop.ERROR);
        return;
    }

    if (this.open_config.paused === paused)
        return;

    if (this.closing_) {
        this.gputop.log("Ignoring attempt to pause OA metrics while waiting for close ACK", this.gputop.ERROR);
        return;
    }

    function _open_with_new_state(config) {
        config.paused = paused;

        if (paused) {
            this.open(config, this.replay_buffer.bind(this));
        } else {
            this.clear_metric_data();
            this.open(config);
        }
    }

    var config = this.open_config;
    this.close(() => {
        _open_with_new_state.call(this, config);
    });
}

Metric.prototype.filter_counters = function(options) {
    var flags = options.flags;
    var results = {
        matched: [],
        others: []
    };

    var debug = false;
    if (options.debug !== undefined)
        debug = options.debug;

    var active = true;
    if (options.active !== undefined)
        active = options.active;

    for (var i = 0; i < this.cc_counters.length; i++) {
        var counter = this.cc_counters[i];
        var filter = true;

        for (var j = 0; j < flags.length; j++) {
            if (counter.flags.indexOf(flags[j]) < 0) {
                filter = false;
                break;
            }
        }

        if (debug === false) {
            if (counter.symbol_name === "GpuTime")
                filter = false;
        }

        if (active && counter.zero)
            filter = false;

        if (filter)
            results.matched.push(counter);
        else
            results.others.push(counter);
    }

    return results;
}

function Process_info () {
    this.pid_ = 0;
    this.process_name_ = "empty";
    this.cmd_line_ = "empty";
    this.active_ = false;
    this.process_path_ = "empty";

    // List of ctx ids on this process
    this.context_ids_ = [];

    // Did we ask gputop about this process?
    this.init_ = false;
}

Process_info.prototype.update = function(process) {
    this.pid_ = process.pid;
    this.cmd_line_ = process.cmd_line;
    var res = this.cmd_line_.split(" ", 2);

    this.process_path_ = res[0];

    var path = res[0].split("/");
    this.process_name_ = path[path.length-1];
    this.update_process(this);
}

function Gputop () {

    this.connection = undefined;

    /* To support being able to redirect the output of node.js tools
     * we redirect all console logging to stderr... */
    if (is_nodejs)
        this.console = new console.Console(process.stderr, process.stderr);
    else
        this.console = console;

    this.LOG=0;
    this.WARN=1;
    this.ERROR=2;

    this.metrics_ = [];
    this.map_metrics_ = {}; // Map of metrics by GUID

    this.tracepoints_ = [];

    this.is_connected_ = false;

    this.config_ = {
        architecture: 'ukn'
    }
    this.demo_architecture =  "hsw";

    this.get_arch_pretty_name = function() {
        switch (this.config_.architecture) {
            case 'hsw': return "Haswell";
            case 'skl': return "Skylake";
            case 'bdw': return "Broadwell";
            case 'chv': return "Cherryview";
        }
        return this.config_.architecture;
    }
    this.system_properties = {};

    this.builder_ = undefined;
    this.gputop_proto_ = undefined;

    this.socket_ = undefined;

    /* When we send a request to open a stream of metrics we send
     * the server a handle that will be attached to subsequent data
     * for the stream. We use these handles to lookup the metric
     * set that the data corresponds to.
     */
    this.next_server_handle = 1;
    this.server_handle_to_obj = {};

    /* When we open a stream of metrics we also call into the
     * Emscripten compiled cc code to allocate a corresponding
     * struct gputop_cc_stream. This map lets us look up a
     * Metric object given a gputop_cc_stream pointer.
     */
    this.cc_stream_ptr_to_obj_map = {};

    this.current_update_ = { metric: null };

    // Pending RPC request closures, indexed by request uuid,
    // to be called once we receive a reply.
    this.rpc_closures_ = {};

    // Process list map organized by PID
    this.map_processes_ = [];

    if (is_nodejs) {
        this.test_mode = false;
    } else {
        var test = getUrlParameter('test');
        if (test === "true" || test === "1")
            this.test_mode = true;
        else
            this.test_mode = false;
    }
    this.test_log_messages = [];

    this.test_log("Global Gputop object constructed");


    // Enable tools to subclass metric sets and counters even though
    // gputop.js is responsible for allocating these objects...
    this.MetricConstructor = Metric;
    this.CounterConstructor = Counter;
}

Gputop.prototype.is_demo = function() {
    return false;
}

Gputop.prototype.application_log = function(level, message)
{
    this.console.log("APP LOG: (" + level + ") " + message.trim());
}

Gputop.prototype.log = function(message, level)
{
    if (level === undefined)
        level = this.LOG;

    switch (level) {
    case this.LOG:
        this.console.log(message);
        break;
    case this.WARN:
        this.console.warn("WARN:" + message);
        break;
    case this.ERROR:
        this.console.error("ERROR:" + message);
        break;
    default:
        this.console.error("Unknown log level " + level + ": " + message);
    }
}

Gputop.prototype.user_msg = function(message, level)
{
    this.log(message, level);
}

/* For unit test feedback, sent back to server in test mode */
Gputop.prototype.test_log = function(message) {
    if (this.test_mode) {
        this.test_log_messages.push(message);
        this.flush_test_log();
    }
}

Gputop.prototype.flush_test_log = function() {
    if (this.socket_) {
        for (var i = 0; i < this.test_log_messages.length; i++) {
            this.rpc_request('test_log', this.test_log_messages[i]);
        }
        this.test_log_messages = [];
    }
}

Gputop.prototype.get_process_by_pid = function(pid) {
    var process = this.map_processes_[pid];
    if (process == undefined) {
        process = new Process_info();
        this.map_processes_[pid] = process;
    }
    return process;
}

Gputop.prototype.get_metrics_xml = function() {
    return this.metrics_xml_;
}

Gputop.prototype.parse_counter_xml = function(metric, xml_elem) {
    var $cnt = $(xml_elem);

    var counter = new metric.gputop.CounterConstructor(metric);
    counter.name = $cnt.attr("name");
    counter.symbol_name = $cnt.attr("symbol_name");
    counter.underscore_name = $cnt.attr("underscore_name");
    counter.description = $cnt.attr("description");
    counter.flags = $cnt.attr("mdapi_usage_flags").split(" ");
    counter.eq_xml = ($cnt.find("mathml_EQ"));
    counter.max_eq_xml = ($cnt.find("mathml_MAX_EQ"));
    if (counter.max_eq_xml.length == 0)
        counter.max_eq_xml = undefined;
    counter.xml_ = $cnt;

    var units = $cnt.attr("units");
    if (units === "us") {
        units = "ns";
        counter.units_scale = 1000;
    }
    if (units === "mhz") {
        units = "hz";
        counter.units_scale *= 1000000;
    }
    counter.units = units;

     if (units === 'hz' || units === 'percent')
         counter.duration_dependent = false;

    metric.add_counter.call(metric, counter);
}

Gputop.prototype.get_metric_by_id = function(idx){
    return this.metrics_[idx];
}

Gputop.prototype.lookup_metric_for_guid = function(guid){
    var metric;
    if (guid in this.map_metrics_) {
        metric = this.map_metrics_[guid];
    } else {
        metric = new this.MetricConstructor(this);
        metric.guid_ = guid;
        this.map_metrics_[guid] = metric;
    }
    return metric;
}

Gputop.prototype.parse_metrics_set_xml = function (xml_elem) {
    var guid = $(xml_elem).attr("hw_config_guid");
    var metric = this.lookup_metric_for_guid(guid);
    metric.xml_ = $(xml_elem);
    metric.name = $(xml_elem).attr("name");

    this.log('Parsing metric set:' + metric.name);
    this.log("  HW config GUID: " + guid);

    metric.symbol_name = $(xml_elem).attr("symbol_name");
    metric.underscore_name = $(xml_elem).attr("underscore_name");
    metric.chipset_ = $(xml_elem).attr("chipset");

    // We populate our array with metrics in the same order as the XML
    // The metric will already be defined when the features query finishes
    metric.metric_set_index_ = Object.keys(this.metrics_).length;
    this.metrics_[metric.metric_set_index_] = metric;

    $(xml_elem).find("counter").each((i, elem) => {
        this.parse_counter_xml(metric, elem);
    });
}

Gputop.prototype.stream_start_update = function (stream_ptr,
                                                 start_timestamp,
                                                 end_timestamp,
                                                 reason) {
    var update = this.current_update_;

    if (!(stream_ptr in this.cc_stream_ptr_to_obj_map)) {
        console.error("Ignoring spurious update for unknown stream");
        update.metric = null;
        return;
    }

    update.metric = this.cc_stream_ptr_to_obj_map[stream_ptr];
    update.start_timestamp = start_timestamp;
    update.end_timestamp = end_timestamp;
    update.reason = reason;
}

Gputop.prototype.stream_update_counter = function (stream_ptr,
                                                   counter_id,
                                                   max,
                                                   value) {
    var update = this.current_update_;

    var metric = update.metric;
    if (metric === null) {
        /* Will have already logged an error when starting the update */
        return;
    }

    if (counter_id >= metric.cc_counters.length) {
        console.error("Ignoring spurious counter update for out-of-range counter index " + counter_id);
        return;
    }

    var counter = metric.cc_counters[counter_id];
    counter.append_counter_data(update.start_timestamp,
                                update.end_timestamp,
                                max, value,
                                update.reason);
}

Gputop.prototype.stream_end_update = function (stream_ptr) {
    var update = this.current_update_;

    var metric = update.metric;
    if (metric === null) {
        /* Will have already logged an error when starting the update */
        return;
    }

    update.metric = null;

    this.notify_metric_updated(metric);
}

Gputop.prototype.notify_metric_updated = function (metric) {
    /* NOP */
}

Gputop.prototype.parse_xml_metrics = function(xml) {
    this.metrics_xml_ = xml;

    $(xml).find("set").each((i, elem) => {
        this.parse_metrics_set_xml(elem);
    });
    if (this.is_demo())
        $('#gputop-metrics-panel').load("ajax/metrics.html");
}

Gputop.prototype.set_demo_architecture = function(architecture) {
    this.dispose();

    this.demo_architecture = architecture;
    this.is_connected_ = true;
    this.request_features();
}

Gputop.prototype.set_architecture = function(architecture) {
    this.config_.architecture = architecture;
}

Metric.prototype.open = function(config,
                                 onopen,
                                 onclose,
                                 onerror) {

    var stream = new Stream(this.gputop.next_server_handle++);

    if (onopen !== undefined)
        stream.on('open', onopen);

    if (onclose !== undefined)
        stream.on('close', onclose);

    if (onerror !== undefined)
        stream.on('error', onerror);

    if (this.supported_ == false) {
        var ev = { type: "error", msg: this.guid_ + " " + this.name + " not supported by this kernel" };
        stream.dispatchEvent(ev);
        return null;
    }

    if (this.closing_) {
        var ev = { type: "error", msg: "Can't open metric while also waiting for it to close" };
        stream.dispatchEvent(ev);
        return null;
    }

    if (this.stream != undefined) {
        var ev = { type: "error", msg: "Can't re-open OA metric without explicitly closing first" };
        stream.dispatchEvent(ev);
        return null;
    }

    if (config === undefined)
        config = {};

    if (config.oa_exponent === undefined)
        config.oa_exponent = 14;
    if (config.per_ctx_mode === undefined)
        config.per_ctx_mode = false;
    if (config.paused === undefined)
        config.paused = false;

    this.open_config = config;
    this.stream = stream;

    function _finalize_open() {
        this.gputop.log("Opened OA metric set " + this.name);

        var sp = cc.Runtime.stackSave();

        this.cc_stream_ptr_ =
            cc._gputop_cc_oa_stream_new(String_pointerify_on_stack(this.guid_),
                                        config.per_ctx_mode,
                                        this.period_ns_);

        cc.Runtime.stackRestore(sp);

        this.gputop.cc_stream_ptr_to_obj_map[this.cc_stream_ptr_] = this;

        var ev = { type: "open" };
        stream.dispatchEvent(ev);
    }

    if (config.paused === true) {
        stream.server_handle = 0;
        _finalize_open.call(this);
    } else {
        var oa_query = new this.gputop.gputop_proto_.OAQueryInfo();

        oa_query.guid = this.guid_;
        oa_query.period_exponent = config.oa_exponent;

        var open = new this.gputop.gputop_proto_.OpenQuery();

        open.set('id', stream.server_handle);
        open.set('oa_query', oa_query);
        open.set('overwrite', false);   /* don't overwrite old samples */
        open.set('live_updates', true); /* send live updates */
        open.set('per_ctx_mode', config.per_ctx_mode);

        this.gputop.server_handle_to_obj[open.id] = this;

        this.gputop.rpc_request('open_query', open, _finalize_open.bind(this));

        this.history = [];
        this.history_size = 0;
    }

    return stream;
}

Metric.prototype.destroy_stream = function () {
    _gputop_cc_stream_destroy(this.cc_stream_ptr_);
    delete this.gputop.cc_stream_ptr_to_obj_map[this.cc_stream_ptr_];
    delete this.gputop.server_handle_to_obj[this.stream.server_handle];

    this.cc_stream_ptr_ = 0;
    this.open_config = undefined;

    var stream = this.stream;
    this.stream = undefined;
}

Metric.prototype.close = function(onclose) {
    if (this.stream === undefined) {
        this.gputop.log("Redundant OA metric close request", this.gputop.ERROR);
        return;
    }

    if (this.closing_ === true ) {
        var ev = { type: "error", msg: "Pile Up: ignoring repeated request to close oa metric set (already waiting for close ACK)" };
        this.stream.dispatchEvent(ev);
        return;
    }

    function _finish_close() {
        this.destroy_stream();

        this.closing_ = false;

        if (onclose !== undefined)
            onclose();

        var ev = { type: "close" };
        stream.dispatchEvent(ev);
    }

    this.closing_ = true;

    /* XXX: May have a stream but no server handle while metric is paused */
    if (this.stream.server_handle === 0) {
        _finish_close.call(this);
    } else {
        this.gputop.rpc_request('close_query', this.stream.server_handle, (msg) => {
            _finish_close.call(this);
        });
    }
}

Gputop.prototype.calculate_max_exponent_for_period = function(nsec) {
    for (var i = 0; i < 64; i++) {
        var period = (1<<i) * 1000000000 / this.system_properties.timestamp_frequency;

        if (period > nsec)
            return Math.max(0, i - 1);
    }

    return i;
}

var EventTarget = function() {
    this.listeners = {};
};

EventTarget.prototype.listeners = null;
EventTarget.prototype.removeEventListener = function(type, callback) {
    if(!(type in this.listeners)) {
        return;
    }
    var stack = this.listeners[type];
    for(var i = 0, l = stack.length; i < l; i++){
        if(stack[i] === callback){
            stack.splice(i, 1);
            return this.removeEventListener(type, callback);
        }
    }
};

EventTarget.prototype.addEventListener = function(type, callback) {
    if(!(type in this.listeners)) {
        this.listeners[type] = [];
    }
    this.removeEventListener(type, callback);
    this.listeners[type].push(callback);
};

EventTarget.prototype.dispatchEvent = function(event){
    if(!(event.type in this.listeners)) {
        return;
    }
    var stack = this.listeners[event.type];
    event.target = this;
    for(var i = 0, l = stack.length; i < l; i++) {
        stack[i].call(this, event);
    }
};

EventTarget.prototype.on = function(type, callback) {
    this.addEventListener(type, callback);
}

EventTarget.prototype.once = function(type, callback) {
  function _once_wraper() {
    this.removeListener(type, _once_wrapper);
    return callback.apply(this, arguments);
  }
  return this.on(type, _once_wrapper);
};

var Stream = function(server_handle) {
    EventTarget.call(this);

    this.server_handle = server_handle
}

Stream.prototype = Object.create(EventTarget.prototype);

Gputop.prototype.request_open_cpu_stats = function(config, callback) {
    var stream = new Stream(this.next_server_handle++);

    var cpu_stats = new this.gputop_proto_.CpuStatsInfo();
    if ('sample_period_ms' in config)
        cpu_stats.set('sample_period_ms', config.sample_period_ms);
    else
        cpu_stats.set('sample_period_ms', 10);

    var open = new this.gputop_proto_.OpenQuery();
    open.set('id', stream.server_handle);
    open.set('cpu_stats', cpu_stats);
    open.set('overwrite', false);   /* don't overwrite old samples */
    open.set('live_updates', true); /* send live updates */

    /* FIXME: remove from OpenQuery - not relevant to opening cpu stats */
    open.set('per_ctx_mode', false);

    if (callback !== undefined)
        stream.on('open', callback);

    this.rpc_request('open_query', open, () => {
        this.server_handle_to_obj[open.id] = stream;

        var ev = { type: "open" };
        stream.dispatchEvent(ev);
    });

    return stream;
}

Gputop.prototype.get_tracepoint_info = function(name, callback) {
    function parse_field(str) {
        var field = {};

        var subfields = str.split(';');

        for (var i = 0; i < subfields.length; i++) {
            var subfield = subfields[i].trim();

            if (subfield.match('^field:')) {
                var tokens = subfield.split(':')[1].split(' ');
                field.name = tokens[tokens.length - 1];
                field.type = tokens.slice(0, -1).join(' ');
            } else if (subfield.match('^offset:')) {
                field.offset = Number(subfield.split(':')[1]);
            } else if (subfield.match('^size:')) {
                field.size = Number(subfield.split(':')[1]);
            } else if (subfield.match('^signed:')) {
                field.signed = Boolean(Number(subfield.split(':')[1]));
            }
        }

        return field;
    }

    function parse_tracepoint_format(str) {
        var tracepoint = {};

        var lines = str.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];

            if (line.match('^name:'))
                tracepoint.name = line.slice(6);
            else if (line.match('^ID:'))
                tracepoint.id = Number(line.slice(4));
            else if (line.match('^print fmt:'))
                tracepoint.print_format = line.slice(11);
            else if (line.match('^format:')) {
                tracepoint.common_fields = [];
                tracepoint.event_fields = [];

                for (i++; lines[i].match('^\tfield:'); i++) {
                    line = lines[i];
                    var field = parse_field(line.slice(1));
                    tracepoint.common_fields.push(field);
                }
                if (lines[i + 1].match('\tfield:')) {
                    for (i++; lines[i].match('^\tfield:'); i++) {
                        line = lines[i];
                        var field = parse_field(line.slice(1));
                        tracepoint.event_fields.push(field);
                    }
                }
                break;
            }
        }

        return tracepoint;
    }

    this.rpc_request('get_tracepoint_info', name, (msg) => {
        var tracepoint = {};

        tracepoint.name = name;

        tracepoint.id = msg.tracepoint_info.id;

        var format = msg.tracepoint_info.sample_format;
        console.log("Full format description = " + format);

        var tracepoint = parse_tracepoint_format(format);
        console.log("Structured format = " + JSON.stringify(tracepoint));

        callback(tracepoint);
    });
}

Gputop.prototype.open_tracepoint = function(tracepoint_info, config, onopen, onclose, onerror) {

    var stream = new Stream(this.next_server_handle++);

    stream.info = tracepoint_info;

    if (onopen !== undefined)
        stream.on('open', onopen);

    if (onclose !== undefined)
        stream.on('close', onclose);

    if (onerror !== undefined)
        stream.on('error', onerror);

    if (this.closing_) {
        var ev = { type: "error", msg: "Can't open metric while also waiting for it to close" };
        stream.dispatchEvent(ev);
        return null;
    }

    if (this.stream != undefined) {
        var ev = { type: "error", msg: "Can't re-open OA metric without explicitly closing first" };
        stream.dispatchEvent(ev);
        return null;
    }

    if (config.paused === undefined)
        config.paused = false;
    if (config.pid === undefined)
        config.pid = -1;
    if (config.cpu === undefined) {
        if (config.pid === -1)
            config.cpu = 0;
        else
            config.cpu = -1;
    }

    this.tracepoints_.push(stream);

    function _finalize_open() {
        this.log("Opened tracepoint " + tracepoint_info.name);

        var sp = cc.Runtime.stackSave();

        stream.cc_stream_ptr_ = cc._gputop_cc_tracepoint_stream_new();

        tracepoint_info.common_fields.forEach((field) => {
            var name_c_string = String_pointerify_on_stack(field.name);
            var type_c_string = String_pointerify_on_stack(field.type);

            cc._gputop_cc_tracepoint_add_field(stream.cc_stream_ptr_,
                                               name_c_string,
                                               type_c_string,
                                               field.offset,
                                               field.size,
                                               field.signed);
        });

        tracepoint_info.event_fields.forEach((field) => {
            var name_c_string = String_pointerify_on_stack(field.name);
            var type_c_string = String_pointerify_on_stack(field.type);

            cc._gputop_cc_tracepoint_add_field(stream.cc_stream_ptr_,
                                               name_c_string,
                                               type_c_string,
                                               field.offset,
                                               field.size,
                                               field.signed);
        });

        cc.Runtime.stackRestore(sp);

        this.cc_stream_ptr_to_obj_map[stream.cc_stream_ptr_] = stream;

        if (callback != undefined)
            callback(stream);
    }

    if (config.paused) {
        stream.server_handle = 0;
        _finalize_open.call(this);
    } else {
        var tracepoint = new this.gputop_proto_.TracepointConfig();

        tracepoint.set('pid', config.pid);
        tracepoint.set('cpu', config.cpu);

        tracepoint.set('id', tracepoint_info.id);

        var open = new this.gputop_proto_.OpenQuery();
        open.set('id', stream.server_handle);
        open.set('tracepoint', tracepoint);
        open.set('overwrite', false);   /* don't overwrite old samples */
        open.set('live_updates', true); /* send live updates */

        /* FIXME: remove from OpenQuery - not relevant to opening a tracepoint */
        open.set('per_ctx_mode', false);

        console.log("REQUEST = " + JSON.stringify(open));
        this.rpc_request('open_query', open, () => {
            this.server_handle_to_obj[open.id] = stream;

            _finalize_open.call(this);

            var ev = { type: "open" };
            stream.dispatchEvent(ev);
        });
    }

    return stream;
}

function String_pointerify_on_stack(js_string) {
    return cc.allocate(cc.intArrayFromString(js_string), 'i8', cc.ALLOC_STACK);
}

Gputop.prototype.generate_uuid = function()
{
    /* Concise uuid generator from:
     * http://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript
     */
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
        return v.toString(16);
    });
}

/* TODO: maybe make @value unnecessary for methods that take no data. */
Gputop.prototype.rpc_request = function(method, value, closure) {

    if (this.is_demo()) {
        if (closure != undefined)
            window.setTimeout(closure);
        return;
    }

    var msg = new this.gputop_proto_.Request();

    msg.uuid = this.generate_uuid();

    msg.set(method, value);

    msg.encode();
    this.socket_.send(msg.toArrayBuffer());

    this.log("RPC: " + msg.req + " request: ID = " + msg.uuid);

    if (closure != undefined) {
        this.rpc_closures_[msg.uuid] = closure;

        console.assert(Object.keys(this.rpc_closures_).length < 1000,
                       "Leaking RPC closures");
    }
}

Gputop.prototype.request_features = function() {
    if (!this.is_demo()) {
        if (this.socket_.readyState == is_nodejs ? 1 : WebSocket.OPEN) {
            this.rpc_request('get_features', true);
        } else {
            this.log("Can't request features while not connected", this.ERROR);
        }
    } else {
        var demo_devinfo = new this.gputop_proto_.DevInfo();

        demo_devinfo.set('devname', this.demo_architecture);

        demo_devinfo.set('timestamp_frequency', 12500000);

        var n_eus = 0;
        var threads_per_eu = 7;

        switch (this.demo_architecture) {
        case 'hsw':
            demo_devinfo.set('devid', 0x0422);
            demo_devinfo.set('gen', 7);
            demo_devinfo.set('n_eu_slices', 2);
            demo_devinfo.set('n_eu_sub_slices', 2);
            n_eus = 40;
            demo_devinfo.set('slice_mask', 0x3);
            demo_devinfo.set('subslice_mask', 0xf);
            break;
        case 'bdw':
            demo_devinfo.set('devid', 0x1616);
            demo_devinfo.set('gen', 8);
            demo_devinfo.set('n_eu_slices', 2);
            demo_devinfo.set('n_eu_sub_slices', 3);
            n_eus = 48;
            demo_devinfo.set('slice_mask', 0x3);
            demo_devinfo.set('subslice_mask', 0x3f);
            break;
        case 'chv':
            demo_devinfo.set('devid', 0x22b0);
            demo_devinfo.set('gen', 8);
            demo_devinfo.set('n_eu_slices', 1);
            demo_devinfo.set('n_eu_sub_slices', 2);
            n_eus = 16;
            demo_devinfo.set('slice_mask', 0x1);
            demo_devinfo.set('subslice_mask', 0x3);
            break;
        case 'skl':
            demo_devinfo.set('devid', 0x1926);
            demo_devinfo.set('gen', 9);
            demo_devinfo.set('n_eu_slices', 3);
            demo_devinfo.set('n_eu_sub_slices', 3);
            n_eus = 72;
            demo_devinfo.set('slice_mask', 0x7);
            demo_devinfo.set('subslice_mask', 0x1ff);
            demo_devinfo.set('timestamp_frequency', 12000000);
            break;
        default:
            console.error("Unknown architecture to demo");
        }

        demo_devinfo.set('n_eus', n_eus);
        demo_devinfo.set('eu_threads_count', n_eus * threads_per_eu);
        demo_devinfo.set('gt_min_freq', 500000000);
        demo_devinfo.set('gt_max_freq', 1100000000);

        var demo_features = new this.gputop_proto_.Features();

        demo_features.set('devinfo', demo_devinfo);
        demo_features.set('has_gl_performance_query', false);
        demo_features.set('has_i915_oa', true);
        demo_features.set('n_cpus', 4);
        demo_features.set('cpu_model', 'Intel(R) Core(TM) i7-4500U CPU @ 1.80GHz');
        demo_features.set('kernel_release', '4.5.0-rc4');
        demo_features.set('fake_mode', false);
        demo_features.set('supported_oa_query_guids', []);

        this.process_features(demo_features);
    }
}

Gputop.prototype.process_features = function(features){

    this.features = features;

    this.devinfo = features.devinfo;

    this.log("Features: ");
    this.log("CPU: " + features.get_cpu_model());
    this.log("Architecture: " + features.devinfo.devname);
    this.set_architecture(features.devinfo.devname);

    this.system_properties = {};
    cc._gputop_cc_reset_system_properties();

    var DevInfo = this.builder_.lookup("gputop.DevInfo");
    var fields = DevInfo.getChildren(ProtoBuf.Reflect.Message.Field);
    fields.forEach((field) => {
        var val = 0;
        var name_c_string = String_pointerify_on_stack(field.name);

        switch (field.type.name) {
        case "uint64":
            /* NB uint64 types are handled via long.js and we're being lazy
             * for now and casting to a Number when forwarding to the cc
             * api. Later we could add a set_system_property_u64() api if
             * necessary */
            val = features.devinfo[field.name].toInt();
            cc._gputop_cc_set_system_property(name_c_string, val);
            break;
        case "uint32":
            val = features.devinfo[field.name];
            cc._gputop_cc_set_system_property(name_c_string, val);
            break;
        case "string":
            val = features.devinfo[field.name];
            /* FIXME: allow forwarding string properties to cc via
             * a _set_system_property_string() api */
            break;
        default:
            console.error("Unexpected DevInfo " + field.name + " field type");
            val = features.devinfo[field.name];
            break;
        }

        this.system_properties[field.name] = val;
    });


    cc._gputop_cc_update_system_metrics();

    this.xml_file_name_ = "gputop-" + this.config_.architecture + ".xml";

    get_file(this.xml_file_name_, (xml) => {
        this.parse_xml_metrics(xml);

        if (this.is_demo())
            this.metrics_.forEach(function (metric) { metric.supported_ = true; });
        else {
            this.metrics_.forEach(function (metric) { metric.supported_ = false; });

            if (features.supported_oa_query_guids.length == 0) {
                this.user_msg("No OA metrics are supported on this Kernel " +
                              features.get_kernel_release(), this.ERROR);
            } else {
                this.log("Metrics:");
                features.supported_oa_query_guids.forEach((guid, i, a) => {
                    var metric = this.lookup_metric_for_guid(guid);
                    metric.supported_ = true;
                    this.log("  " + metric.name + " (guid = " + guid + ")");
                });
            }
        }

        this.update_features(features);
    }, function (error) { console.log(error); });
}

Gputop.prototype.load_emscripten = function(callback) {
    if (this.native_js_loaded_) {
        callback();
        return;
    }

    if (!is_nodejs) {
        get_file('gputop-web.js',
                (text) => {
                    var src = text + '\n' + '//# sourceURL=gputop-web.js\n';

                    $('<script type="text/javascript">').text(src).appendTo(document.body);

                    cc = Module;

                    /* Tell gputop client-c about this object so
                     * that the cc code can call methods on it...
                     */
                    cc.gputop_singleton = this;

                    this.native_js_loaded_ = true;
                    this.log("GPUTop Emscripten code loaded\n");
                    callback();
                },
                function () {
                    this.log( "Failed loading emscripten", this.ERROR);
                });
    } else {
        /* In the case of node.js we use require('./gputop-web.js') to
         * load the Emscripten code so this is mostly a NOP...
         */
        this.native_js_loaded_ = true;

        /* Tell gputop client-c about this object so that the cc
         * code can call methods on it...
         */
        cc._gputop_cc_set_singleton(this);
        console.log("Initialized gputop_singleton");
        callback();
    }
}

Gputop.prototype.dispose = function() {
    if (this.socket_ !== undefined)
        this.socket_.close();
    this.socket_ = undefined;

    this.is_connected_ = false;

    this.metrics_.forEach(function (metric) {
        if (!metric.closing_ && metric.cc_stream_ptr_)
            metric.destroy_stream();
    });

    this.metrics_ = [];
    this.map_metrics_ = {}; // Map of metrics by GUID

    this.cc_stream_ptr_to_obj_map = {};
    this.server_handle_to_obj = {};
}

function gputop_socket_on_message(evt) {
    var dv = new DataView(evt.data, 0);
    var data = new Uint8Array(evt.data, 8);
    var msg_type = dv.getUint8(0);

    switch(msg_type) {
    case 1: /* WS_MESSAGE_PERF */
        var server_handle = dv.getUint16(4, true /* little endian */);

        if (server_handle in this.server_handle_to_obj) {
            var sp = cc.Runtime.stackSave();

            var stack_data = cc.allocate(data, 'i8', cc.ALLOC_STACK);

            var stream = this.server_handle_to_obj[server_handle];

            // save messages in a buffer to replay when query is paused
            /*
            metric.history.push(data);
            metric.history_size += data.length;
            if (metric.history_size > 1048576) // 1 MB of data
                metric.history.shift();
                */

            cc._gputop_cc_handle_tracepoint_message(stream.cc_stream_ptr_,
                                                    stack_data,
                                                    data.length);

            cc.Runtime.stackRestore(sp);
        } else {
            console.log("Ignoring i915 perf data for unknown Metric object")
        }
        break;
    case 2: /* WS_MESSAGE_PROTOBUF */
        var msg = this.gputop_proto_.Message.decode(data);

        switch (msg.cmd) {
        case 'features':
            this.process_features(msg.features);
            break;
        case 'error':
            this.user_msg(msg.error, this.ERROR);
            this.log(msg.reply_uuid + " recv: Error " + msg.error, this.ERROR);
            break;
        case 'log':
            var entries = msg.log.entries;
            entries.forEach((entry) => {
                this.application_log(entry.log_level, entry.log_message);
            });
            break;
        case 'process_info':
            var pid = msg.process_info.pid;
            var process = this.get_process_by_pid(pid);

            process.update(msg.process_info);
            this.log(msg.reply_uuid + " recv: Console process info "+pid);
            break;
        case 'cpu_stats':
            var server_handle = msg.cpu_stats.id;

            if (server_handle in this.server_handle_to_obj) {
                var stream = this.server_handle_to_obj[server_handle];

                var ev = { type: "update", stats: msg.cpu_stats };
                stream.dispatchEvent(ev);
            }
            break;
        }

        if (msg.reply_uuid in this.rpc_closures_) {
            var closure = this.rpc_closures_[msg.reply_uuid];
            closure(msg);
            delete this.rpc_closures_[msg.reply_uuid];
        }

        break;
    case 3: /* WS_MESSAGE_I915_PERF */
        var server_handle = dv.getUint16(4, true /* little endian */);

        if (server_handle in this.server_handle_to_obj) {
            var sp = cc.Runtime.stackSave();

            var stack_data = cc.allocate(data, 'i8', cc.ALLOC_STACK);

            var metric = this.server_handle_to_obj[server_handle];

            // save messages in a buffer to replay when query is paused
            metric.history.push(data);
            metric.history_size += data.length;
            if (metric.history_size > 1048576) // 1 MB of data
                metric.history.shift();

            cc._gputop_cc_handle_i915_perf_message(metric.cc_stream_ptr_,
                                                   stack_data,
                                                   data.length);

            cc.Runtime.stackRestore(sp);
        } else {
            console.log("Ignoring i915 perf data for unknown Metric object")
        }
        break;
    }
}

Gputop.prototype.get_process_info = function(pid, callback) {
    this.rpc_request('get_process_info', pid, callback);
}

Gputop.prototype.connect_web_socket = function(websocket_url, onopen, onclose, onerror) {
    try {
        var socket = new WebSocket(websocket_url, "binary");
    } catch (e) {
        gputop.log("new WebSocket error", this.ERROR);
        if (onerror !== undefined)
            onerror();
        return null;
    }
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
        this.user_msg("Connected to GPUTOP");
        this.flush_test_log();
        if (onopen !== undefined)
            onopen();
    }

    socket.onclose = () => {
        if (onclose !== undefined)
            onclose();

        this.dispose();

        this.user_msg("Disconnected");
    }

    if (onerror !== undefined)
        socket.onerror = onerror;

    socket.onmessage = gputop_socket_on_message.bind(this);

    return socket;
}

Gputop.prototype.load_gputop_proto = function(onload) {
    get_file('gputop.proto', (proto) => {
        this.builder_ = ProtoBuf.newBuilder();

        ProtoBuf.protoFromString(proto, this.builder_, "gputop.proto");

        this.gputop_proto_ = this.builder_.build("gputop");

        onload();
    },
    function (error) { console.log(error); });
}

var GputopConnection = function(gputopObj) {
    EventTarget.call(this);

    this.gputop = gputopObj;
}

GputopConnection.prototype = Object.create(EventTarget.prototype);

Gputop.prototype.connect = function(address, onopen, onclose, onerror) {
    this.dispose();

    if (this.connection === undefined)
        this.connection = new GputopConnection(this);

    if (onopen !== undefined)
        this.connection.on('open', onopen);

    if (onclose !== undefined)
        this.connection.on('close', onclose);

    if (onerror !== undefined)
        this.connection.on('error', onerror);

    this.load_emscripten(() => {
        this.load_gputop_proto(() => {
            if (!this.is_demo()) {
                var websocket_url = 'ws://' + address + '/gputop/';
                this.log('Connecting to ' + websocket_url);
                this.socket_ = this.connect_web_socket(websocket_url, () => { //onopen
                    this.is_connected_ = true;
                    this.request_features();

                    var ev = { type: "open" };
                    this.connection.dispatchEvent(ev);
                },
                () => { //onclose
                    var ev = { type: "close" };
                    this.connection.dispatchEvent(ev);
                },
                () => { //onerror
                    var ev = { type: "error" };
                    this.connection.dispatchEvent(ev);
                });
            } else {
                this.is_connected_ = true;
                this.request_features();

                var ev = { type: "open" };
                this.connection.dispatchEvent(ev);
            }
        });
    });

    return this.connection;
}

if (is_nodejs) {
    /* For use as a node.js module... */
    exports.Gputop = Gputop;
    exports.Metric = Metric;
    exports.Counter = Counter;
}
