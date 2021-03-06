// app.js
// Main entry point for pdal session delegation
//
process.title = 'gh_sh';
process.on('uncaughtException', function(err) {
    console.log('Caught at top level: ' + err);
});

process.on('uncaughtException', function(err) {
    console.log('Caught at top level: ' + err);
});

var express = require("express"),
    _ = require('lodash'),
    methodOverride = require('method-override'),
    bodyParser = require('body-parser'),
    app = express(),

    net = require('net'),
    disco = require('../common').disco,
    console = require('clim')(),
    config = (require('../config').sh || { }),
    globalConfig = (require('../config').global || { }),
    mkdirp = require('mkdirp'),

    PdalSession = require('./build/Release/pdalBindings').PdalBindings,

    serialCompress =
        (config.serialCompress == undefined) ? true : !!config.serialCompress,

    // serialPaths[0] is to be used for writing new serialized entries.
    // serialPaths[0..n] are to be searched when looking for serialized entries.
    serialPaths = (function() {
        if (!config.serialAllowed) return undefined;

        var paths = [];
        var defaultSerialPath = '/var/greyhound/serial/';

        var tryCreate = function(dir) {
            try {
                mkdirp.sync(dir);
                serialPath = dir;
                return true;
            }
            catch (err) {
                console.error('Could not create serial path', dir);
                return false;
            }
        };

        if (config.serialPaths &&
            config.serialPaths.length &&
            typeof serialPaths[0] === 'string') {

            if (tryCreate(serialPaths[0])) {
                paths = serialPaths;
                paths.push(defaultSerialPath);
            }
        }

        if (!paths || !paths.length) {
            if (tryCreate(defaultSerialPath)) {
                paths.push(defaultSerialPath);
            }
        }

        if (!paths.length) {
            console.error('Serialization disabled');
        }

        return paths.length ? paths : undefined;
    })();

console.log('Serial paths:', serialPaths);

// configure express application
app.use(methodOverride());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
app.use(app.router);

var sessions    = { }; // sessionId -> pdalSession (may be many to one)
var pipelineIds = { }; // pipelineId -> pdalSession (one to one)

var getSession = function(res, sessionId, cb) {
    if (!sessions[sessionId])
        return res.json(404, { message: 'No such session' });

    cb(sessionId, sessions[sessionId]);
};

var error = function(res) {
    return function(err) {
        res.json(500, { message: err.message || 'Unknown error' });
    };
};

var parseArray = function(rawArray, isInt) {
    var coords = [];

    for (var i in rawArray) {
        if (isInt) coords.push(parseInt(rawArray[i]));
        else coords.push(parseFloat(rawArray[i]));
    }

    return coords;
}

var validateRasterSchema = function(schema) {
    // Schema must have X and Y dimensions, and at least one other dimension.
    var xFound = false, yFound = false, otherFound = false;
    for (var i = 0; i < schema.length; ++i) {
        if      (schema[i].name == 'X') xFound = true;
        else if (schema[i].name == 'Y') yFound = true;
        else otherFound = true;
    }

    return xFound && yFound && otherFound;
}

app.get("/", function(req, res) {
    res.json(404, { message: 'Invalid service URL' });
});

// handlers for our API
app.get("/validate", function(req, res) {
    var pdalSession = new PdalSession();
    pdalSession.parse(
        '',
        req.body.pipeline,
        serialCompress,
        serialPaths,
        function(err) {
            pdalSession.destroy();
            if (err) console.log('Pipeline validation error:', err);
            res.json({ valid: err ? false : true });
        }
    );
});

app.post("/create", function(req, res) {
    console.log(':session-handler:CREATE');
    var pipelineId = req.body.pipelineId;
    var pipeline = req.body.pipeline;
    var pdalSession = pipelineIds[pipelineId] || new PdalSession();
    var sessionId = req.body.sessionId;

    // Make sure to set these outside of the callback so that if another
    // request for this pipeline comes immediately after this one, it doesn't
    // create a new PdalSession and clobber our pipelineIds mapping.
    sessions[sessionId]     = pdalSession;
    pipelineIds[pipelineId] = pdalSession;

    // It is safe to call create multiple times on a PdalSession, and it will
    // only actually be created one time.  Subsequent create calls will come
    // back immediately if the initial creation is complete, or if the initial
    // creation is still in progress, then the callback will be executed when
    // that call completes.
    pdalSession.create(
        pipelineId,
        pipeline,
        serialCompress,
        serialPaths,
        function(err)
    {
        if (err) {
            console.log('Error in CREATE:', err);
            return error(res)(err);
        }

        console.log('Created session:', sessionId);
        res.json({ sessionId: sessionId });
    });
});

app.delete("/sessions/:sessionId", function(req, res) {
    var sessionId = req.params.sessionId;
    if (sessions.hasOwnProperty(sessionId)) {
        delete sessions[sessionId];
    }
    return res.json({ message: 'Removed session ' + sessionId });
});

app.delete("/:pipelineId", function(req, res) {
    var sessionsRemoved = [];
    var pipelineId = req.params.pipelineId;

    if (pipelineIds.hasOwnProperty(pipelineId)) {
        for (var sessionId in sessions) {
            if (sessions[sessionId] === pipelineIds[pipelineId]) {
                sessionsRemoved.push(sessionId);
                delete sessions[sessionId];
            }
        }

        pipelineIds[pipelineId].destroy();
        delete pipelineIds[pipelineId];

        console.log('DESTROY pipelineId', pipelineId);
        return res.json({ message: 'Deleted', sessions: sessionsRemoved });
    }
    else {
        return res.json(
            400,
            { message: 'Pipeline not found' });
    }
});

app.get("/pointsCount/:sessionId", function(req, res) {
    getSession(res, req.params.sessionId, function(sessionId, pdalSession) {
        res.json({ count: pdalSession.getNumPoints() });
    });
});

app.get("/schema/:sessionId", function(req, res) {
    getSession(res, req.params.sessionId, function(sessionId, pdalSession) {
        var dimensions = JSON.parse(pdalSession.getSchema()).dimensions;
        var schema = undefined;

        if (dimensions && _.isArray(dimensions)) {
            schema = new Array(dimensions.length);
            var dim;

            for (var i = 0; i < schema.length; ++i) {
                schema[i] = { };
                dim = dimensions[i];

                if (
                        !dim.name || !dim.name.value ||
                        !dim.type || !dim.type.value ||
                        !dim.size || !dim.size.value) {
                    return res.json(400, { message: 'Invalid PDAL schema' });
                }

                schema[i].name = dim.name.value;
                schema[i].type = dim.type.value;
                schema[i].size = dim.size.value;
            }
        }

        res.json({ schema: schema });
    });
});

app.get("/stats/:sessionId", function(req, res) {
    getSession(res, req.params.sessionId, function(sessionId, pdalSession) {
        res.json({ stats: pdalSession.getStats() });
    });
});

app.get("/srs/:sessionId", function(req, res) {
    getSession(res, req.params.sessionId, function(sessionId, pdalSession) {
        res.json({ srs: pdalSession.getSrs() });
    });
});

app.get("/fills/:sessionId", function(req, res) {
    getSession(res, req.params.sessionId, function(sessionId, pdalSession) {
        res.json({ fills: pdalSession.getFills() });
    });
});

app.get("/serialize/:sessionId", function(req, res) {
    if (!config.serialAllowed || !serialPaths) {
        return res.json(400, {
            message: 'Serialization disabled'
        });
    }

    getSession(res, req.params.sessionId, function(sessionId, pdalSession) {
        pdalSession.serialize(serialPaths, function(err) {
            if (err) console.log('ERROR during serialization:', err);
        });
        res.json({ message: 'Serialization task launched' });
    });
});

app.post("/cancel/:sessionId", function(req, res) {
    getSession(res, req.params.sessionId, function(sessionId, pdalSession) {
        console.log('Got CANCEL request for session', sessionId);
        res.json({ 'cancelled': pdalSession.cancel(req.body.readId) });
    });
});

app.post("/read/:sessionId", function(req, res) {
    var args = req.body;

    var host = args.host;
    var port = parseInt(args.port);
    var compress = args.compress ? JSON.parse(args.compress) : false;
    var schema = args.hasOwnProperty('schema') ? JSON.parse(args.schema) : [];

    if (args.hasOwnProperty('resolution')) {
        args['resolution'] = JSON.parse(args.resolution);
    }

    console.log("session handler: /read/");

    if (!host)
        return res.json(
            400,
            { message: 'Destination host needs to be specified' });

    if (!port)
        return res.json(
            400,
            { message: 'Destination port needs to be specified' });

    // Prune our args to simplify the specialization decision tree.
    delete args.command;
    delete args.session;
    delete args.host;
    delete args.port;
    if (args.hasOwnProperty('compress')) delete args.compress;
    if (args.hasOwnProperty('schema')) delete args.schema;

    getSession(res, req.params.sessionId, function(sessionId, pdalSession) {
        console.log('read('+ sessionId + ')');

        var readHandler = function(
            err,
            readId,
            numPoints,
            numBytes,
            xBegin,
            xStep,
            xNum,
            yBegin,
            yStep,
            yNum)
        {
            if (err) {
                console.log('Erroring read:', err);
                return res.json(400, { message: err });
            }
            else {
                if (xNum && yNum) {
                    res.json({
                        readId: readId,
                        numPoints: numPoints,
                        numBytes: numBytes,
                        rasterMeta: {
                            xBegin: xBegin,
                            xStep: xStep,
                            xNum: xNum,
                            yBegin: yBegin,
                            yStep: yStep,
                            yNum: yNum
                        },
                        message:
                            'Request queued for transmission to ' +
                            host + ':' + port,
                    });
                }
                else {
                    res.json({
                        readId: readId,
                        numPoints: numPoints,
                        numBytes: numBytes,
                        message:
                            'Request queued for transmission to ' +
                            host + ':' + port,
                    });
                }
            }
        };

        // Send the results to the websocket-handler.
        var socket = net.createConnection(port, host);
        socket.on('close', function() {
            console.log('Socket closed');
        }).on('error', function(err) {
            // This is an expected occurence.  A cancel request
            // will cause the websocket-handler to forcefully reset
            // the connection.
            console.log('Socket force-closed:', err);
        });

        var dataHandler = function(err, data, done) {
            if (err) socket.end();

            socket.write(data);
            if (done) socket.end();
        }

        if (
            args.hasOwnProperty('start') ||
            args.hasOwnProperty('count') ||
            Object.keys(args).length == 0) {

            // Unindexed read - 'start' and 'count' may be omitted.  If either
            // of them exists, or if the only arguments are
            // host+port+cmd+session, then use this branch.
            console.log('    Got unindexed read request');

            var start = args.hasOwnProperty('start') ? parseInt(args.start) : 0;
            var count = args.hasOwnProperty('count') ? parseInt(args.count) : 0;

            if (start < 0) start = 0;
            if (count < 0) count = 0;

            pdalSession.read(
                    host,
                    port,
                    compress,
                    schema,
                    start,
                    count,
                    readHandler,
                    dataHandler);
        }
        else if (
            args.hasOwnProperty('bbox') &&
            args.hasOwnProperty('resolution')) {

            console.log('    Got generic raster read request');

            if (schema.hasOwnProperty('schema') &&
                !validateRasterSchema(schema)) {

                console.log(
                        'Invalid schema in raster request', schema);

                return res.json(
                    400,
                    { message: 'Bad schema - must contain X and Y' });
            }

            var bbox = parseArray(args.bbox);
            var resolution = parseArray(args.resolution, true);

            if (bbox.length != 4 || resolution.length != 2) {
                console.log('    Bad args in generic raster request', args);
                return res.json(
                    400,
                    { message: 'Invalid read command - bad params' });
            }

            pdalSession.read(
                host,
                port,
                compress,
                schema,
                bbox,
                resolution,
                readHandler,
                dataHandler);
        }
        else if (
            args.hasOwnProperty('bbox') ||
            args.hasOwnProperty('depthBegin') ||
            args.hasOwnProperty('depthEnd')) {

            console.log('    Got quad-tree depth range read request');

            // Indexed read: quadtree query.
            var bbox =
                args.hasOwnProperty('bbox') ?
                    parseArray(args.bbox) :
                    undefined;

            var depthBegin =
                args.hasOwnProperty('depthBegin') ?
                    parseInt(args.depthBegin) :
                    0;

            var depthEnd =
                args.hasOwnProperty('depthEnd') ?
                    parseInt(args.depthEnd) :
                    0;

            pdalSession.read(
                    host,
                    port,
                    compress,
                    schema,
                    bbox,
                    depthBegin,
                    depthEnd,
                    readHandler,
                    dataHandler);
        }
        else if (args.hasOwnProperty('rasterize')) {
            var rasterize = parseInt(args.rasterize);

            console.log('    Got quad-tree single-level raster read request');

            if (schema.hasOwnProperty('schema') &&
                !validateRasterSchema(schema)) {

                console.log(
                        'Invalid schema in raster request', schema);

                return res.json(
                    400,
                    { message: 'Bad schema - must contain X and Y' });
            }

            pdalSession.read(
                    host,
                    port,
                    compress,
                    schema,
                    rasterize,
                    readHandler,
                    dataHandler);
        }
        else if (
            args.hasOwnProperty('radius') &&
            args.hasOwnProperty('x') &&
            args.hasOwnProperty('y')) {

            // Indexed read: point + radius query.
            console.log('    Got point-radius read request');

            var is3d = args.hasOwnProperty('z');
            var radius = parseFloat(args.radius);
            var x = parseFloat(args.x);
            var y = parseFloat(args.y);
            var z = is3d ? parseFloat(args.z) : 0.0;

            pdalSession.read(
                    host,
                    port,
                    compress,
                    schema,
                    is3d,
                    radius,
                    x,
                    y,
                    z,
                    readHandler,
                    dataHandler);
        }
        else {
            console.log('Got bad read request', args);
            return res.json(
                400,
                { message: 'Invalid read command - bad params' });
        }
    });
});

if (config.enable !== false) {
    disco.register("sh", config.port, function(err, service) {
        if (err) return console.log("Failed to start service:", err);

        var port = service.port;

        app.listen(port, function() {
            console.log('Session handler listening on port: ' + port);
        });
    });
}
else {
    process.exit(globalConfig.quitForeverExitCode || 42);
}

