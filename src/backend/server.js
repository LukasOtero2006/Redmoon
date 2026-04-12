import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { Player } from "./classes/Player.js";
import { RoomManager } from "./classes/RoomManager.js";
import { UserManager } from "./classes/UserManager.js";

const wss = new WebSocketServer({ port: 3000 });

class LobbyServer {
    constructor(server) {
        this.wss = server;
        this.roomManager = new RoomManager();
        this.userManager = new UserManager();
        this.playerSessions = new Map();
    }

    broadcast(room, message) {
        room.players.forEach((player) => {
            if (player.ws.readyState === 1) {
                player.ws.send(JSON.stringify(message));
            }
        });
    }

    sendPlayerList(room) {
        this.broadcast(room, {
            type: "playerList",
            roomCode: room.code,
            players: room.getPlayerList()
        });
    }

    removePlayerFromRoom(ws) {
        if (!ws.session) {
            return;
        }

        const room = this.roomManager.getRoom(ws.session.roomCode);

        if (!room) {
            ws.session = null;
            return;
        }

        room.removePlayer(ws.session.playerId);

        if (room.players.length === 0) {
            this.roomManager.deleteRoom(room.code);
        } else {
            this.sendPlayerList(room);
        }

        ws.session = null;
    }

    start() {
        this.wss.on("connection", (ws) => {
            ws.session = null;

            ws.on("message", (data) => this.handleMessage(ws, data));
            ws.on("close", () => this.handleClose(ws));
        });
    }

    parseMessage(ws, data) {
        try {
            return JSON.parse(data);
        } catch {
            ws.send(JSON.stringify({ type: "error", message: "Mensaje invalido" }));
            return null;
        }
    }

    handleMessage(ws, data) {
        const msg = this.parseMessage(ws, data);

        if (!msg) {
            return;
        }

        if (msg.type === "register") {
            const { username, email, password } = msg;

            if (!username || !email || !password) {
                ws.send(JSON.stringify({ type: "error", message: "Rellena todos los campos" }));
                return;
            }

            const result = this.userManager.register(username, email, password);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            ws.send(JSON.stringify({
                type: "registerSuccess",
                user: result.user
            }));
            return;
        }

        if (msg.type === "login") {
            const { username, password } = msg;

            if (!username || !password) {
                ws.send(JSON.stringify({ type: "error", message: "Usuario y contraseña requeridos" }));
                return;
            }

            const result = this.userManager.login(username, password);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            ws.session = { userId: result.user.userId, username };
            this.playerSessions.set(result.user.userId, ws);

            ws.send(JSON.stringify({
                type: "loginSuccess",
                user: result.user
            }));
            return;
        }

        if (msg.type === "createRoom") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            this.removePlayerFromRoom(ws);

            const hostPlayer = new Player(ws.session.userId, ws.session.username, ws);
            const room = this.roomManager.createRoom(hostPlayer);
            ws.session.roomCode = room.code;
            ws.session.playerId = hostPlayer.id;

            ws.send(JSON.stringify({
                type: "roomCreated",
                roomCode: room.code,
                playerId: hostPlayer.id,
                playerName: hostPlayer.name
            }));

            this.sendPlayerList(room);
            return;
        }

        if (msg.type === "joinRoom") {
            const roomCode = String(msg.roomCode || "").trim().toUpperCase();

            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            if (!roomCode) {
                ws.send(JSON.stringify({ type: "error", message: "Codigo de sala requerido" }));
                return;
            }

            if (!this.roomManager.roomExists(roomCode)) {
                ws.send(JSON.stringify({ type: "error", message: "Sala no existe" }));
                return;
            }

            this.removePlayerFromRoom(ws);

            const room = this.roomManager.getRoom(roomCode);
            const player = new Player(ws.session.userId, ws.session.username, ws);

            room.addPlayer(player);
            ws.session.roomCode = room.code;
            ws.session.playerId = player.id;

            ws.send(JSON.stringify({
                type: "joinedRoom",
                roomCode: room.code,
                playerId: player.id,
                playerName: player.name
            }));

            this.sendPlayerList(room);
            return;
        }

        if (msg.type === "kickPlayer") {
            if (!ws.session || !ws.session.roomCode) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const room = this.roomManager.getRoom(ws.session.roomCode);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "Sala no encontrada" }));
                return;
            }

            const kickResult = room.kickPlayer(msg.playerId, ws.session.playerId);

            if (!kickResult.success) {
                ws.send(JSON.stringify({ type: "error", message: kickResult.message }));
                return;
            }

            const kickedPlayer = room.players.find((p) => p.id === msg.playerId);

            if (kickedPlayer && kickedPlayer.ws) {
                kickedPlayer.ws.send(JSON.stringify({
                    type: "kicked",
                    message: "Fuiste expulsado de la sala"
                }));
                this.removePlayerFromRoom(kickedPlayer);
            }

            this.sendPlayerList(room);
            return;
        }

        if (msg.type === "adminGetUsers") {
            const users = this.userManager.getAllUsers();
            ws.send(JSON.stringify({
                type: "adminUsersList",
                users,
                totalUsers: users.length
            }));
            return;
        }
    }

    handleClose(ws) {
        if (ws.session && ws.session.userId) {
            this.playerSessions.delete(ws.session.userId);
        }

        this.removePlayerFromRoom(ws);
    }
}

const lobbyServer = new LobbyServer(wss);
lobbyServer.start();
