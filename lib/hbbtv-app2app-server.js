/*******************************************************************************
 * 
 * Copyright (c) 2015 Louay Bassbouss, Fraunhofer FOKUS, All rights reserved.
 * 
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3.0 of the License, or (at your option) any later version.
 * 
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 * 
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library. If not, see <http://www.gnu.org/licenses/>. 
 * 
 * AUTHORS: Louay Bassbouss (louay.bassbouss@fokus.fraunhofer.de)
 *
 ******************************************************************************/
var ws = require("ws");
var util = require("util");
var events = require("events");
var WebSocketServer = ws.Server;
var HbbTVApp2AppServer = function (httpServer) {
    // Helper to generate unique IDs for debugging
    var generateId = function(prefix) {
        return prefix + "_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    };

    var wsServer = null;
    var pendingLocalConnections = {};
    var pendingRemoteConnections = {};
    var handlePendingConnectionsChanged = function (channel) {
        var channelPendingLocalConnections = pendingLocalConnections[channel] || [];
        var channelPendingRemoteConnections = pendingRemoteConnections[channel] || [];
        while (channelPendingLocalConnections.length > 0 && channelPendingRemoteConnections.length > 0) {
            var localConnection = channelPendingLocalConnections.pop();
            var remoteConnection = channelPendingRemoteConnections.pop();
            localConnection.pair = remoteConnection;
            remoteConnection.pair = localConnection;
            console.log("--> PAIRING SUCCESS: Channel [" + channel + "] paired " + localConnection.id + " <==> " + remoteConnection.id);
            if (localConnection && localConnection.readyState == ws.OPEN) {
                localConnection.send("pairingcompleted");
            }
            if (remoteConnection && remoteConnection.readyState == ws.OPEN) {
                remoteConnection.send("pairingcompleted");
            }
        }
        if (channelPendingLocalConnections.length == 0) {
            delete pendingLocalConnections[channel];
        }
        if (channelPendingRemoteConnections.length == 0) {
            delete pendingRemoteConnections[channel];
        }
    };

    var handleConnectionClosed = function (connection) {
        var type = connection.local ? "local" : "remote";
        console.log("Connection closed: [" + connection.id + "] (" + type + ") Channel: " + JSON.stringify(connection.channel));

        if (connection.local) {
            var channelPendingLocalConnections = pendingLocalConnections[connection.channel] || [];
            var index = channelPendingLocalConnections.indexOf(connection);
            if (index >= 0) {
                console.log("Removing [" + connection.id + "] from pending local list.");
                channelPendingLocalConnections.splice(index, 1);
            }
            if (channelPendingLocalConnections.length == 0) {
                delete pendingLocalConnections[connection.channel];
            }
        } else if (connection.remote) {
            var channelPendingRemoteConnections = pendingRemoteConnections[connection.channel] || [];
            var index = channelPendingRemoteConnections.indexOf(connection);
            if (index >= 0) {
                console.log("Removing [" + connection.id + "] from pending remote list.");
                channelPendingRemoteConnections.splice(index, 1);
            }
            if (channelPendingRemoteConnections.length == 0) {
                delete pendingRemoteConnections[connection.channel];
            }
        }
    };

    var handleConnectionReceived = function(connection) {
        var req = connection.upgradeReq;
        if(req.channel){
            var channel = req.channel;
            connection.channel = channel;
            if(req.local){
                connection.local = true;
                connection.id = generateId("local");
                console.log("Connection received: [" + connection.id + "] waiting on channel " + JSON.stringify(req.channel));
                var channelPendingLocalConnections = pendingLocalConnections[channel] || (pendingLocalConnections[channel] = []);
                channelPendingLocalConnections.push(connection);
            }
            else {
                connection.remote = true;
                connection.id = generateId("remote");
                console.log("Connection received: [" + connection.id + "] waiting on channel " + JSON.stringify(req.channel));
                var channelPendingRemoteConnections = pendingRemoteConnections[channel] || (pendingRemoteConnections[channel] = []);
                channelPendingRemoteConnections.push(connection);
            }
            handlePendingConnectionsChanged(channel);
            connection.on("message", function(msg, flags) {
                var options = {};
                flags.binary && (options.binary = true);
                flags.masked && (options.masked = true);
                if (connection.pair && connection.pair.readyState == ws.OPEN) {
                    connection.pair.send(msg, options);
                }
            });
            connection.on("close", function(code, reason) {
                if(connection.pair){
                    console.log("Peer disconnect: [" + connection.id + "] is closing its pair [" + connection.pair.id + "]");
                    connection.pair.pair = null; 
                    connection.pair.close();
                    connection.pair = null;
                }
                else {
                    handleConnectionClosed(connection);
                }
                connection = null;
            });
            connection.on("error", function (error) {
                console.error("Socket error on [" + (connection.id || 'unknown') + "]:", error);
                try {
                    connection.close();
                } catch (e) {
                    // ignore if already closed
                }
            });
        }
        else {
            console.log("Connection rejected: No channel specified.");
            connection.close();
        }
    };

    var verifyClient = function (info,callback) {
        var req = info.req;
        var url = req.url || "";
        var channel = null;
        var verified = false;
        if(url.indexOf("/local/") == 0){
            channel = url.substr(7) || null;
            req.local = true;
        }
        else if(url.indexOf("/remote/") == 0){
            channel = url.substr(8) || null;
            req.local = false;
        }
        if(channel){
            req.channel = channel;
            verified = true;
        }
        callback && callback(verified);
    };

    var reset = function () {
        wsServer && wsServer.close();
        wsServer = null;
        pendingLocalConnections = {};
        pendingRemoteConnections = {};
    };

    var start = function () {
        reset();
        wsServer = new WebSocketServer({
            server: httpServer,
            verifyClient : verifyClient
        }).on("connection", handleConnectionReceived);
        this.emit("ready");
        return this;
    };

    var stop = function () {
        reset();
        this.emit("stop");
        return this;
    };

    Object.defineProperty(this, "start", { get: function () { return start; } });
    Object.defineProperty(this, "stop", { get: function () { return stop; } });
};

util.inherits(HbbTVApp2AppServer, events.EventEmitter);

module.exports = HbbTVApp2AppServer;