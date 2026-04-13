import { WebSocketServer } from "ws";
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

    sendRoomState(room) {
        this.broadcast(room, {
            type: "roomState",
            ...room.getState()
        });
    }

    sendUserProfile(userId) {
        const targetSocket = this.playerSessions.get(userId);
        const user = this.userManager.getUserById(userId);

        if (!targetSocket || !user) {
            return;
        }

        targetSocket.send(JSON.stringify({
            type: "profileUpdate",
            user: this.userManager.toClientUser(user)
        }));
    }

    roomFromSession(ws) {
        if (!ws.session || !ws.session.roomCode) {
            return null;
        }

        return this.roomManager.getRoom(ws.session.roomCode);
    }

    removePlayerFromRoom(ws) {
        if (!ws.session || !ws.session.roomCode || !ws.session.playerId) {
            return;
        }

        const room = this.roomManager.getRoom(ws.session.roomCode);

        if (!room) {
            delete ws.session.roomCode;
            delete ws.session.playerId;
            return;
        }

        room.removePlayer(ws.session.playerId);

        if (room.players.length === 0) {
            this.roomManager.deleteRoom(room.code);
        } else {
            this.sendPlayerList(room);
            this.sendRoomState(room);
        }

        delete ws.session.roomCode;
        delete ws.session.playerId;
    }

    start() {
        this.wss.on("connection", (ws) => {
            ws.session = null;
            console.log("[SERVER] Nueva conexion WebSocket establecida");

            ws.on("message", (data) => this.handleMessage(ws, data));
            ws.on("close", () => this.handleClose(ws));
        });
    }

    parseMessage(ws, data) {
        try {
            return JSON.parse(data.toString());
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
            const username = String(msg.username || "").trim();
            const email = String(msg.email || "").trim().toLowerCase();
            const password = String(msg.password || "").trim();
            console.log(`[REGISTER] Recibido: usuario=${username}, email=${email}, pass=${password ? password.length + ' chars' : 'undefined'}`);

            if (!username || !email || !password) {
                console.log("[REGISTER] Error: campos vacios");
                ws.send(JSON.stringify({ type: "error", message: "Rellena todos los campos" }));
                return;
            }

            if (username.length < 3) {
                ws.send(JSON.stringify({ type: "error", message: "Usuario: minimo 3 caracteres" }));
                return;
            }

            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                ws.send(JSON.stringify({ type: "error", message: "Email invalido" }));
                return;
            }

            if (password.length < 6) {
                ws.send(JSON.stringify({ type: "error", message: "Contraseña: minimo 6 caracteres" }));
                return;
            }

            const result = this.userManager.register(username, email, password);

            if (!result.success) {
                console.log(`[REGISTER] Error: ${result.message}`);
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            console.log(`[REGISTER] Exito: usuario ${username} registrado`);
            ws.send(JSON.stringify({
                type: "registerSuccess",
                user: result.user
            }));
            return;
        }

        if (msg.type === "login") {
            const identifier = String(msg.username || "").trim();
            const password = String(msg.password || "").trim();
            console.log(`[LOGIN] Recibido: identificador=${identifier}, pass=${password ? password.length + ' chars' : 'undefined'}`);

            if (!identifier || !password) {
                console.log("[LOGIN] Error: campos vacios");
                ws.send(JSON.stringify({ type: "error", message: "Usuario/email y contraseña requeridos" }));
                return;
            }

            const result = this.userManager.login(identifier, password);

            if (!result.success) {
                console.log(`[LOGIN] Error: ${result.message}`);
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            ws.session = { userId: result.user.userId, username: result.user.username };
            this.playerSessions.set(result.user.userId, ws);

            console.log(`[LOGIN] Exito: usuario ${result.user.username} logueado`);
            ws.send(JSON.stringify({
                type: "loginSuccess",
                user: result.user
            }));
            return;
        }

        if (msg.type === "respondFriendRequest") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const fromUserId = String(msg.fromUserId || "").trim();
            const accept = Boolean(msg.accept);
            const result = this.userManager.respondFriendRequest(ws.session.userId, fromUserId, accept);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.sendUserProfile(ws.session.userId);
            this.sendUserProfile(fromUserId);
            return;
        }

        if (msg.type === "leaveRoom") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            this.removePlayerFromRoom(ws);
            ws.send(JSON.stringify({ type: "leftRoom" }));
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
            this.sendRoomState(room);
            return;
        }

        if (msg.type === "joinRoom") {
            const { roomCode } = msg;

            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            if (!roomCode) {
                ws.send(JSON.stringify({ type: "error", message: "Codigo de sala requerido" }));
                return;
            }

            this.removePlayerFromRoom(ws);

            const room = this.roomManager.getRoom(roomCode);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "Sala no encontrada" }));
                return;
            }

            const player = new Player(ws.session.userId, ws.session.username, ws);
            const joinResult = room.addPlayer(player);

            if (!joinResult.success) {
                ws.send(JSON.stringify({ type: "error", message: joinResult.message }));
                return;
            }

            ws.session.roomCode = roomCode;
            ws.session.playerId = player.id;

            ws.send(JSON.stringify({
                type: "joinedRoom",
                roomCode: room.code,
                playerId: player.id,
                playerName: player.name
            }));

            this.sendPlayerList(room);
            this.sendRoomState(room);
            ws.send(JSON.stringify({
                type: "roomChatHistory",
                messages: room.chatMessages
            }));
            return;
        }

        if (msg.type === "setNickname") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.setPlayerNickname(ws.session.userId, msg.nickname);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.sendPlayerList(room);
            return;
        }

        if (msg.type === "sendRoomChat") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.addChatMessage(ws.session.userId, msg.text);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.broadcast(room, {
                type: "roomChatMessage",
                message: result.message
            });
            return;
        }

        if (msg.type === "sendFriendRequest") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const toUserId = String(msg.toUserId || "").trim();
            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "Solo puedes enviar solicitudes dentro de una sala" }));
                return;
            }

            const targetInRoom = room.players.some((p) => p.id === toUserId);

            if (!targetInRoom) {
                ws.send(JSON.stringify({ type: "error", message: "Solo puedes solicitar amistad a jugadores de tu sala" }));
                return;
            }

            const result = this.userManager.sendFriendRequest(ws.session.userId, toUserId);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.sendUserProfile(ws.session.userId);
            this.sendUserProfile(toUserId);

            const requester = this.userManager.getUserById(ws.session.userId);
            const targetSocket = this.playerSessions.get(toUserId);

            if (requester && targetSocket && targetSocket.readyState === 1) {
                targetSocket.send(JSON.stringify({
                    type: "friendRequestReceived",
                    fromUser: {
                        userId: requester.userId,
                        username: requester.username
                    }
                }));
            }

            ws.send(JSON.stringify({ type: "info", message: "Solicitud enviada" }));
            return;
        }

        if (msg.type === "updateRoomSettings") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.updateSettings(ws.session.userId, msg.settings || {});

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.sendRoomState(room);
            return;
        }

        if (msg.type === "startGame") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.startGame(ws.session.userId);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.sendRoomState(room);
            this.sendPlayerList(room);
            this.broadcast(room, {
                type: "roomChatHistory",
                messages: []
            });

            room.players.forEach((player) => {
                if (player.ws.readyState === 1) {
                    player.ws.send(JSON.stringify({
                        type: "gameStarted",
                        phase: room.gamePhase,
                        role: result.playerRoles[player.id] || "Aldeano"
                    }));
                }
            });

            this.broadcast(room, {
                type: "roomChatMessage",
                message: {
                    senderId: "system",
                    senderName: "Sistema",
                    text: "La partida ha comenzado. Los motes quedan bloqueados.",
                    sentAt: new Date().toISOString()
                }
            });
            return;
        }

        if (msg.type === "setGamePhase") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.setGamePhase(ws.session.userId, String(msg.phase || "").trim());

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.sendRoomState(room);
            this.broadcast(room, {
                type: "info",
                message: room.gamePhase === "night" ? "Comienza la noche" : "Amanece: empieza el dia"
            });
            return;
        }

        if (msg.type === "kickPlayer") {
            const { playerId } = msg;

            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomManager.getRoom(ws.session.roomCode);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "Sala no encontrada" }));
                return;
            }

            const kickResult = room.kickPlayer(playerId, ws.session.userId);

            if (!kickResult.success) {
                ws.send(JSON.stringify({ type: "error", message: kickResult.message }));
                return;
            }

            const kickedSocket = this.playerSessions.get(playerId);

            if (kickedSocket) {
                kickedSocket.send(JSON.stringify({ type: "kicked", message: "Has sido expulsado de la sala" }));
                this.removePlayerFromRoom(kickedSocket);
            }

            this.sendPlayerList(room);
            this.sendRoomState(room);
            return;
        }

        if (msg.type === "adminGetUsers") {
            const users = this.userManager.getAllUsers();
            ws.send(JSON.stringify({ type: "adminUsersList", users }));
            return;
        }
    }

    handleClose(ws) {
        console.log("[SERVER] Conexion cerrada");
        if (ws.session && ws.session.userId) {
            this.playerSessions.delete(ws.session.userId);
        }
        this.removePlayerFromRoom(ws);
    }
}

const lobby = new LobbyServer(wss);
lobby.start();
console.log("[SERVER] Servidor en puerto 3000");
