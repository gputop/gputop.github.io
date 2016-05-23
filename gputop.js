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

    var webc = require("./gputop-web.js");
    webc.gputop_singleton = undefined;

    var install_prefix = require.resolve("./gputop-web.js");
    var path = require('path');
    install_prefix = path.resolve(install_prefix, '..');

    console.log("install prefix = " + install_prefix);

    is_nodejs = true;
} else {
    var webc = undefined;

    ProtoBuf = dcodeIO.ProtoBuf;
    var $ = window.jQuery;
}

function get_file(filename, load_callback, error_callback) {
    if (is_nodejs) {
        fs.readFile(path.join(install_prefix, filename), 'utf8', (err, data) => {
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

function gputop_is_demo() {

    if (!is_nodejs) {
        var demo = getUrlParameter('demo');
        if (demo == "true" || demo == "1"
                || window.location.hostname == "gputop.github.io"
                || window.location.hostname == "www.gputop.com"
                //      || window.location.hostname == "localhost"
           ) {
            return true;
        }
    }

    return false;
}


function Counter () {
    /* Index into metric.webc_counters_, understood by gputop-web.c code */
    this.webc_counter_id_ = -1;
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
    this.graph_data = [];
    this.graph_options = []; /* each counter has its own graph options so that
                              * we can adjust the Y axis for each of them */
    this.units = '';
    this.graph_markings = [];

    /* whether append_counter_data() should really append to counter.updates[] */
    this.record_data = false;

    this.eq_xml = ""; // mathml equation
    this.max_eq_xml = ""; // mathml max equation
    this.duration_dependent = true;
    this.test_mode = false;
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

function Metric () {
    this.name = "not loaded";
    this.symbol_name = "UnInitialized";
    this.chipset_ = "not loaded";

    this.guid_ = "undefined";
    this.xml_ = "<xml/>";
    this.supported_ = false;
    this.webc_counters = []; /* Counters applicable to this system, supported via
                              * gputop-web.c */
    this.counters_ = [];     /* All possible counters associated with this metric
                              * set (not necessarily all supported by the current
                              * system */
    this.counters_map_ = {}; // Map of counters by with symbol_name
    this.metric_set_ = 0;

    this.server_handle = 0;
    this.webc_stream_ptr_ = 0;

    this.per_ctx_mode_ = false;

    // Aggregation period
    this.period_ns_ = 1000000000;

    // OA HW periodic timer exponent
    this.exponent = 14;
    this.history = []; // buffer used when query is paused.
    this.history_index = 0;
    this.history_size = 0;
}

Metric.prototype.is_per_ctx_mode = function() {
    return this.per_ctx_mode_;
}

Metric.prototype.find_counter_by_name = function(symbol_name) {
    return this.counters_map_[symbol_name];
}

/* FIXME: some of this should be handled in the Counter constructor */
Metric.prototype.add_new_counter = function(counter) {
    var symbol_name = counter.symbol_name;

    /* FIXME: this should be handled by gputop-ui.js somehow! */
    counter.graph_options = {
        grid: {
            borderWidth: 1,
            minBorderMargin: 20,
            labelMargin: 10,
            backgroundColor: {
                colors: ["#fff", "#e4f4f4"]
            },
            margin: {
                top: 8,
                bottom: 20,
                left: 20
            },
        },
        xaxis: {
            show: false,
            panRange: null
        },
        yaxis: {
            min: 0,
            max: 110,
            panRange: false
        },
        legend: {
            show: true
        },
        pan: {
            interactive: true
        }
    };// options

    var sp = webc.Runtime.stackSave();

    var counter_idx = webc._gputop_webc_get_counter_id(String_pointerify_on_stack(this.guid_),
                                                       String_pointerify_on_stack(symbol_name));

    webc.Runtime.stackRestore(sp);

    counter.webc_counter_id_ = counter_idx;
    if (counter_idx != -1) {
        counter.supported_ = true;
        console.log('Counter ' + counter_idx + " " + symbol_name);
        this.webc_counters[counter_idx] = counter;
    } else {
        console.log('Counter not available ' + symbol_name);
    }

    this.counters_map_[symbol_name] = counter;
    this.counters_.push(counter);
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

    this.metrics_ = [];
    this.map_metrics_ = {}; // Map of metrics by GUID

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

    this.builder_ = undefined;

    /* When we send a request to open a stream of metrics we send
     * the server a handle that will be attached to subsequent data
     * for the stream. We use these handles to lookup the metric
     * set that the data corresponds to.
     */
    this.next_server_handle = 1;
    this.server_handle_to_metric_map = {};

    /* When we open a stream of metrics we also call into the
     * Emscripten compiled webc code to allocate a corresponding
     * struct gputop_webc_stream. This map lets us look up a
     * Metric object given a sputop_webc_stream pointer.
     */
    this.webc_stream_ptr_to_metric_map = {};
    this.active_oa_metric_ = undefined;

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
}

/* Application log messages */
Gputop.prototype.log = function(level, message)
{
    console.log("APP LOG: (" + level + ") " + message.trim());
}

/* Internal console.log wrapper in case we want to forward/redirect */
Gputop.prototype.syslog = function(message)
{
    console.log(message);
}

/* User directed messages */
Gputop.prototype.show_alert = function(message, type)
{
    console.log(message);
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
    try {
        var $cnt = $(xml_elem);

        var counter = new Counter();
        counter.name = $cnt.attr("name");
        counter.symbol_name = $cnt.attr("symbol_name");
        counter.underscore_name = $cnt.attr("underscore_name");
        counter.description = $cnt.attr("description");
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

        metric.add_new_counter.call(metric, counter);
    } catch (e) {
        this.syslog("Failed to parse counter: " + e);
    }
}

Gputop.prototype.get_metric_by_id = function(idx){
    return this.metrics_[idx];
}

Gputop.prototype.lookup_metric_for_guid = function(guid){
    var metric;
    if (guid in this.map_metrics_) {
        metric = this.map_metrics_[guid];
    } else {
        metric = new Metric();
        metric.guid_ = guid;
        this.map_metrics_[guid] = metric;
    }
    return metric;
}

Gputop.prototype.parse_metrics_set_xml = function (xml_elem) {
    try {
        var guid = $(xml_elem).attr("guid");
        var metric = this.lookup_metric_for_guid(guid);
        metric.xml_ = $(xml_elem);
        metric.name = $(xml_elem).attr("name");
        metric.symbol_name = $(xml_elem).attr("symbol_name");
        metric.underscore_name = $(xml_elem).attr("underscore_name");
        metric.chipset_ = $(xml_elem).attr("chipset");

        this.syslog(guid + '\n Found metric ' + metric.name);

        // We populate our array with metrics in the same order as the XML
        // The metric will already be defined when the features query finishes
        metric.metric_set_ = Object.keys(this.metrics_).length;
        this.metrics_[metric.metric_set_] = metric;

        $(xml_elem).find("counter").each((i, elem) => {
            this.parse_counter_xml(metric, elem);
        });
    } catch (e) {
        this.syslog("Failed to parse metrics set: " + e);
    }
}

Gputop.prototype.stream_start_update = function (stream_ptr,
                                                 start_timestamp,
                                                 end_timestamp,
                                                 reason) {
    var update = this.current_update_;

    if (!(stream_ptr in this.webc_stream_ptr_to_metric_map)) {
        console.error("Ignoring spurious update for unknown stream");
        update.metric = null;
        return;
    }

    update.metric = this.webc_stream_ptr_to_metric_map[stream_ptr];
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

    if (counter_id >= metric.webc_counters.length) {
        console.error("Ignoring spurious counter update for out-of-range counter index");
        return;
    }

    var counter = metric.webc_counters[counter_id];
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
    if (gputop_is_demo()) {
        $('#gputop-metrics-panel').load("ajax/metrics.html");
    }
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

Gputop.prototype.update_period = function(guid, period_ns) {
    var metric = this.map_metrics_[guid];
    metric.period_ns_ = period_ns;
    webc._gputop_webc_update_stream_period(metric.webc_stream_ptr_, period_ns);
}

Gputop.prototype.open_oa_metric_set = function(config, callback) {

    function _real_open_oa_metric_set(config, callback) {
        var metric = this.lookup_metric_for_guid(config.guid);
        var oa_exponent = metric.exponent;
        var per_ctx_mode = metric.per_ctx_mode_;

        if ('oa_exponent' in config)
            oa_exponent = config.oa_exponent;
        if ('per_ctx_mode' in config)
            per_ctx_mode = config.per_ctx_mode;

        function _finalize_open() {
            this.syslog("Opened OA metric set " + metric.name);

            metric.exponent = oa_exponent;
            metric.per_ctx_mode_ = per_ctx_mode;

            var sp = webc.Runtime.stackSave();

            metric.webc_stream_ptr_ =
                webc._gputop_webc_stream_new(String_pointerify_on_stack(config.guid),
                                             per_ctx_mode,
                                             metric.period_ns_);

            webc.Runtime.stackRestore(sp);

            this.webc_stream_ptr_to_metric_map[metric.webc_stream_ptr_] = metric;

            if (callback != undefined)
                callback(metric);
        }

        this.active_oa_metric_ = metric;

        // if (open.per_ctx_mode)
        //     this.show_alert("Opening metric set " + metric.name + " in per context mode", "alert-info");
        // else
        //     this.show_alert("Opening metric set " + metric.name, "alert-info");


        if ('paused_state' in config) {
            _finalize_open.call(this);
        } else {
            var oa_query = new this.builder_.OAQueryInfo();

            oa_query.guid = config.guid;
            oa_query.period_exponent = oa_exponent;

            var open = new this.builder_.OpenQuery();

            metric.server_handle = this.next_server_handle++;

            open.id = metric.server_handle;
            open.oa_query = oa_query;
            open.overwrite = false;   /* don't overwrite old samples */
            open.live_updates = true; /* send live updates */
            open.per_ctx_mode = per_ctx_mode;

            this.server_handle_to_metric_map[open.id] = metric;

            this.rpc_request('open_query', open, _finalize_open.bind(this));

            metric.history = [];
            metric.history_size = 0;
        }
    }

    if (config.guid === undefined) {
        console.error("No GUID given when opening OA metric set");
        return;
    }

    var metric = this.lookup_metric_for_guid(config.guid);
    if (metric === undefined) {
        console.error('Error: failed to lookup OA metric set with guid = "' + config.guid + '"');
        return;
    }

    if (metric.supported_ == false) {
        this.show_alert(config.guid + " " + metric.name + " not supported on this kernel (guid=" + config.guid + ")", "alert-danger");
        return;
    }

    if (metric.closing_) {
        //this.show_alert("Ignoring attempt to open OA metrics while waiting for close ACK", "alert-danger");
        return;
    }

    if (this.active_oa_metric_ != undefined) {
        this.close_oa_metric_set(this.active_oa_metric_, () => {
            _real_open_oa_metric_set.call(this, config, callback);
        });
    } else
        _real_open_oa_metric_set.call(this, config, callback);
}

Gputop.prototype.close_oa_metric_set = function(metric, callback) {
    if (metric.closing_ == true ) {
        this.syslog("Pile Up: ignoring repeated request to close oa metric set (already waiting for close ACK)");
        return;
    }

    function _finish_close() {
        webc._gputop_webc_stream_destroy(metric.webc_stream_ptr_);
        delete this.webc_stream_ptr_to_metric_map[metric.webc_stream_ptr_];
        delete this.server_handle_to_metric_map[metric.server_handle];

        metric.webc_stream_ptr_ = 0;
        metric.server_handle = 0;

        metric.closing_ = false;

        if (callback != undefined)
            callback();
    }

    //this.show_alert("Closing query " + metric.name, "alert-info");
    metric.closing_ = true;
    this.active_oa_metric_ = undefined;

    if (global_paused_query) {
        _finish_close.call(this);
    } else {
        this.rpc_request('close_query', metric.server_handle, (msg) => {
            _finish_close.call(this);
        });
    }
}

var EventTarget = function() {
    this.listeners = {};
};

EventTarget.prototype.listeners = null;
EventTarget.prototype.addEventListener = function(type, callback) {
    if(!(type in this.listeners)) {
        this.listeners[type] = [];
    }
    this.listeners[type].push(callback);
};

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

var Stream = function(server_handle) {
    EventTarget.call(this);

    this.server_handle = server_handle
}

Stream.prototype = Object.create(EventTarget.prototype);

Gputop.prototype.open_cpu_stats = function(config, callback) {
    var stream = new Stream(this.next_server_handle++);

    var cpu_stats = new this.builder_.CpuStatsInfo();
    if ('sample_period_ms' in config)
        cpu_stats.set('sample_period_ms', config.sample_period_ms);
    else
        cpu_stats.set('sample_period_ms', 10);

    var open = new this.builder_.OpenQuery();
    open.set('id', stream.server_handle);
    open.set('cpu_stats', cpu_stats);
    open.set('overwrite', false);   /* don't overwrite old samples */
    open.set('live_updates', true); /* send live updates */

    /* FIXME: remove from OpenQuery - not relevent to opening cpu stats */
    open.set('per_ctx_mode', false);

    this.rpc_request('open_query', open, () => {
        var ev = { type: "open" };
        stream.dispatchEvent(ev);
    });

    this.cpu_stats_stream = stream;

    return stream;
}

Gputop.prototype.close_active_metric_set = function(callback) {
    if (this.active_oa_metric_ == undefined) {
        this.show_alert("No Active Metric Set", "alert-info");
        return;
    }

    this.close_oa_metric_set(this.active_oa_metric_, callback);
}


function String_pointerify_on_stack(js_string) {
    return webc.allocate(webc.intArrayFromString(js_string), 'i8', webc.ALLOC_STACK);
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

    if (gputop_is_demo()) {
        if (closure != undefined)
            window.setTimeout(closure);
        return;
    }

    var msg = new this.builder_.Request();

    msg.uuid = this.generate_uuid();

    msg.set(method, value);

    msg.encode();
    this.socket_.send(msg.toArrayBuffer());

    this.syslog("RPC: " + msg.req + " request: ID = " + msg.uuid);

    if (closure != undefined) {
        this.rpc_closures_[msg.uuid] = closure;

        console.assert(Object.keys(this.rpc_closures_).length < 1000,
                       "Leaking RPC closures");
    }
}

Gputop.prototype.request_features = function() {
    if (!gputop_is_demo()) {
        if (this.socket_.readyState == is_nodejs ? 1 : WebSocket.OPEN) {
            this.rpc_request('get_features', true);
        } else {
            this.syslog("Not connected");
        }
    } else {
        var demo_devinfo = new this.builder_.DevInfo();

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
        demo_devinfo.set('gt_min_freq', 500);
        demo_devinfo.set('gt_max_freq', 1100);

        var demo_features = new this.builder_.Features();

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
    var di = features.devinfo;

    this.devinfo = di;

    this.set_architecture(di.devname);

    /* We convert the 64 bits protobuffer entry into 32 bits
     * to make it easier to call the emscripten native API.
     * DevInfo values should not overflow the native type,
     * but stay in 64b internally to help native processing in C.
     *
     * XXX: it would be good if there were a more maintainable
     * way of forwarding this info, since it's currently too
     * easy to forget to update this to forward new devinfo
     * state
     */
    webc._gputop_webc_update_features(di.devid,
                                      di.gen,
                                      di.timestamp_frequency.toInt(),
                                      di.n_eus.toInt(),
                                      di.n_eu_slices.toInt(),
                                      di.n_eu_sub_slices.toInt(),
                                      di.eu_threads_count.toInt(),
                                      di.subslice_mask.toInt(),
                                      di.slice_mask.toInt(),
                                      di.gt_min_freq.toInt(),
                                      di.gt_max_freq.toInt());

    this.xml_file_name_ = this.config_.architecture + ".xml";
    console.log(this.config_.architecture);

    get_file(this.xml_file_name_, (xml) => {
        this.parse_xml_metrics(xml);

        if (gputop_is_demo())
            this.metrics_.forEach(function (metric) { metric.supported_ = true; });
        else {
            this.metrics_.forEach(function (metric) { metric.supported_ = false; });

            if (features.supported_oa_query_guids.length == 0) {
                this.show_alert("No OA metrics are supported on this Kernel " +
                                features.get_kernel_release(), "alert-danger");
            } else {
                features.supported_oa_query_guids.forEach((guid, i, a) => {
                    var metric = this.lookup_metric_for_guid(guid);
                    metric.supported_ = true;
                    this.syslog(guid);
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

                    webc = Module;

                    /* Tell gputop-web-lib.js about this object so
                     * that the webc code can call methods on it...
                     */
                    webc.gputop_singleton = this;

                    this.native_js_loaded_ = true;
                    console.log("GPUTop Emscripten code loaded\n");
                    callback();
                },
                function () {
                    console.log( "Failed loading emscripten" );
                });
    } else {
        /* In the case of node.js we use require('./gputop-web.js') to
         * load the Emscripten code so this is mostly a NOP...
         */
        this.native_js_loaded_ = true;

        /* Tell gputop-web-lib.js about this object so that the webc
         * code can call methods on it...
         */
        webc.gputop_singleton = this;
        callback();
    }
}

Gputop.prototype.dispose = function() {
    this.is_connected_ = false;

    this.metrics_.forEach(function (metric) {
        if (!metric.closing_ && metric.webc_stream_ptr_)
            _gputop_webc_stream_destroy(metric.webc_stream_ptr_);
    });

    this.metrics_ = [];
    this.map_metrics_ = {}; // Map of metrics by GUID

    this.webc_stream_ptr_to_metric_map = {};
    this.server_handle_to_metric_map = {};
    this.active_oa_metric_ = undefined;
}

function gputop_socket_on_close() {
    this.dispose();

    this.syslog("Disconnected");
    this.show_alert("Failed connecting to GPUTOP <p\>Retry in 5 seconds","alert-warning");
    // this will automatically close the alert and remove this if the users doesnt close it in 5 secs
    setTimeout(this.connect.bind(this), 5000);

    this.is_connected_ = false;
}

Gputop.prototype.replay_buffer = function() {
    var metric = this.active_oa_metric_;

    this.clear_graphs();

    for (var i = 0; i < metric.history.length; i++) {
        var data = metric.history[i];

        var sp = webc.Runtime.stackSave();

        var stack_data = webc.allocate(data, 'i8', webc.ALLOC_STACK);

        webc._gputop_webc_handle_i915_perf_message(metric.webc_stream_ptr_,
                                                   stack_data,
                                                   data.length);
        webc.Runtime.stackRestore(sp);
    }
}

function gputop_socket_on_message(evt) {
    var dv = new DataView(evt.data, 0);
    var data = new Uint8Array(evt.data, 8);
    var msg_type = dv.getUint8(0);

    data.length
    switch(msg_type) {
    case 1: /* WS_MESSAGE_PERF */
        var id = dv.getUint16(4, true /* little endian */);
        webc._gputop_webc_handle_perf_message(id, data);
        break;
    case 2: /* WS_MESSAGE_PROTOBUF */
        var msg = this.builder_.Message.decode(data);
        if (msg.features != undefined) {
            this.syslog("Features: "+msg.features.get_cpu_model());
            this.process_features(msg.features);
        }
        if (msg.error != undefined) {
            this.show_alert(msg.error,"alert-danger");
            this.syslog(msg.reply_uuid + " recv: Error " + msg.error);
            this.log(4, msg.error);
        }
        if (msg.log != undefined) {
            var entries = msg.log.entries;
            entries.forEach((entry) => {
                this.log(entry.log_level, entry.log_message);
            });
        }
        if (msg.process_info != undefined) {
            var pid = msg.process_info.pid;
            var process = this.get_process_by_pid(pid);

            process.update(msg.process_info);
            this.syslog(msg.reply_uuid + " recv: Console process info "+pid);
        }
        if (msg.cpu_stats != undefined) {
            console.log("cpu stats:" + msg.cpu_stats.cpus[0]);
            for (var i = 0; i < msg.cpu_stats.cpus.length; i++) {
                console.log("> " + i + ") " + msg.cpu_stats.cpus[i]);
            }
        }

        if (msg.reply_uuid in this.rpc_closures_) {
            var closure = this.rpc_closures_[msg.reply_uuid];
            closure(msg);
            delete this.rpc_closures_[msg.reply_uuid];
        }

        break;
    case 3: /* WS_MESSAGE_I915_PERF */
        var server_handle = dv.getUint16(4, true /* little endian */);

        if (server_handle in this.server_handle_to_metric_map) {
            var sp = webc.Runtime.stackSave();

            var stack_data = webc.allocate(data, 'i8', webc.ALLOC_STACK);

            var metric = this.server_handle_to_metric_map[server_handle];

            // save messages in a buffer to replay when query is paused
            metric.history.push(data);
            metric.history_size += data.length;
            if (metric.history_size > 1048576) // 1 MB of data
                metric.history.shift();

            webc._gputop_webc_handle_i915_perf_message(metric.webc_stream_ptr_,
                                                       stack_data,
                                                       data.length);

            webc.Runtime.stackRestore(sp);
        } else {
            console.log("Ignoring i915 perf data for unknown Metric object")
        }
        break;
    }
}

Gputop.prototype.get_process_info = function(pid, callback) {
    this.rpc_request('get_process_info', pid, callback);
}

Gputop.prototype.connect_web_socket = function(websocket_url, onopen) {
    var socket = new WebSocket(websocket_url, "binary");
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
        this.syslog("Connected");
        this.show_alert("Succesfully connected to GPUTOP", "alert-success");
        this.flush_test_log();
        onopen();
    }
    socket.onclose = gputop_socket_on_close.bind(this);
    socket.onmessage = gputop_socket_on_message.bind(this);

    return socket;
}

Gputop.prototype.load_gputop_proto = function(onload) {
    get_file('gputop.proto', (proto) => {
        var proto_builder = ProtoBuf.newBuilder();

        ProtoBuf.protoFromString(proto, proto_builder, "gputop.proto");

        this.builder_ = proto_builder.build("gputop");

        onload();
    },
    function (error) { console.log(error); });
}

Gputop.prototype.connect = function(address, callback) {
    this.dispose();

    this.load_emscripten(() => {
        this.load_gputop_proto(() => {
            if (!gputop_is_demo()) {
                var websocket_url = 'ws://' + address + '/gputop/';
                this.syslog('Connecting to port ' + websocket_url);
                this.socket_ = this.connect_web_socket(websocket_url, () => {
                    this.is_connected_ = true;
                    this.request_features();
                    if (callback !== undefined)
                        callback();
                });
            } else {
                this.is_connected_ = true;
                this.request_features();
                if (callback !== undefined)
                    callback();
            }
        });
    });
}

if (is_nodejs) {
    /* For use as a node.js module... */
    exports.Gputop = Gputop;
}
