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
        this.roomTimers = new Map();
    }

    broadcast(room, message) {
        room.players.forEach((player) => {
            if (player.ws.readyState === 1) {
                player.ws.send(JSON.stringify(message));
            }
        });
    }

    sendToWolves(room, message) {
        room.getAliveWolves().forEach((wolf) => {
            if (wolf.ws.readyState === 1) {
                wolf.ws.send(JSON.stringify(message));
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

        const spectatorMap = room.getSpectatorRoleMap();

        room.players.forEach((player) => {
            if (player.isAlive === false && player.ws.readyState === 1) {
                player.ws.send(JSON.stringify({
                    type: "spectatorRoleMap",
                    players: spectatorMap
                }));
            }
        });
    }

    sendUserProfile(userId) {
        const targetSocket = this.playerSessions.get(userId);
        const user = this.userManager.getUserById(userId);

        if (!targetSocket || !user || targetSocket.readyState !== 1) {
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

    clearRoomTimer(roomCode) {
        const timer = this.roomTimers.get(roomCode);

        if (timer) {
            if (Array.isArray(timer)) {
                timer.forEach((timerId) => clearTimeout(timerId));
            } else {
                clearTimeout(timer);
            }
            this.roomTimers.delete(roomCode);
        }
    }

    setRoomTimer(roomCode, callback, delayMs) {
        this.clearRoomTimer(roomCode);
        const timer = setTimeout(() => {
            this.roomTimers.delete(roomCode);
            callback();
        }, delayMs);
        this.roomTimers.set(roomCode, timer);
    }

    addRoomTimer(roomCode, callback, delayMs) {
        const timer = setTimeout(() => {
            const current = this.roomTimers.get(roomCode);

            if (Array.isArray(current)) {
                this.roomTimers.set(roomCode, current.filter((timerId) => timerId !== timer));
            } else if (current === timer) {
                this.roomTimers.delete(roomCode);
            }

            callback();
        }, delayMs);

        const existing = this.roomTimers.get(roomCode);

        if (Array.isArray(existing)) {
            existing.push(timer);
        } else if (existing) {
            this.roomTimers.set(roomCode, [existing, timer]);
        } else {
            this.roomTimers.set(roomCode, [timer]);
        }
    }

    startNightPhase(roomCode) {
        const room = this.roomManager.getRoom(roomCode);

        if (!room || !room.gameStarted) {
            return;
        }

        room.startNightCycle();
        this.sendRoomState(room);
        this.broadcast(room, {
            type: "phaseInfo",
            message: `Noche ${room.nightNumber}: comienza la ronda de habilidades.`
        });
        this.broadcast(room, {
            type: "firstNightOrder",
            order: room.nightQueue
        });
        this.sendCurrentNightTurn(room);
    }

    sendCurrentNightTurn(room) {
        const phase = room.getCurrentNightPhase();

        if (!phase) {
            this.startDayPhase(room.code);
            return;
        }

        this.sendRoomState(room);
        const tracking = room.startPhaseActionTracking(phase);

        if (tracking.completed) {
            this.advanceNightPhase(room.code);
            return;
        }

        // Auto-advance if a role does not act to avoid hard-locking the match.
        this.setRoomTimer(room.code, () => {
            const currentRoom = this.roomManager.getRoom(room.code);
            if (!currentRoom || !currentRoom.gameStarted) {
                return;
            }

            if (currentRoom.getCurrentNightPhase() === phase) {
                this.broadcast(currentRoom, {
                    type: "info",
                    message: `Tiempo agotado para ${phase}. Se avanza a la siguiente fase.`
                });
                this.advanceNightPhase(currentRoom.code);
            }
        }, 25000);

        if (phase === "night-first-cupid") {
            this.broadcast(room, { type: "phaseInfo", message: "Despierta Cupido" });
            return;
        }

        if (phase === "night-first-wildchild") {
            this.broadcast(room, { type: "phaseInfo", message: "Despierta Niño Salvaje" });
            return;
        }

        if (phase === "night-guard") {
            this.broadcast(room, { type: "phaseInfo", message: "Despierta Guardia" });
            return;
        }

        if (phase === "night-wolves") {
            this.broadcast(room, { type: "phaseInfo", message: "Despiertan los lobos" });
            this.sendToWolves(room, { type: "wolfChatHistory", messages: room.wolfChatMessages });
            return;
        }

        if (phase === "night-doctor") {
            this.broadcast(room, { type: "phaseInfo", message: "Despierta el Doctor" });
            const doctor = room.getAliveDoctor();
            if (doctor && doctor.ws.readyState === 1) {
                doctor.ws.send(JSON.stringify({ type: "doctorTurn", victimId: room.pendingVictimId }));
            }
            return;
        }

        if (phase === "night-witch") {
            this.broadcast(room, { type: "phaseInfo", message: "Despierta la Bruja" });
            room.getPlayersWithRole("Bruja").forEach((witch) => {
                if (witch.ws.readyState === 1) {
                    witch.ws.send(JSON.stringify({
                        type: "witchTurn",
                        victimId: room.pendingVictimId,
                        canHeal: !room.roleState.witchHealUsed,
                        canPoison: !room.roleState.witchPoisonUsed,
                        players: room.getDayVotingEligiblePlayers()
                    }));
                }
            });
            return;
        }

        if (phase === "night-seer") {
            this.broadcast(room, { type: "phaseInfo", message: "Despierta la Vidente" });
            room.getPlayersWithRole("Vidente").forEach((seer) => {
                if (seer.ws.readyState === 1) {
                    seer.ws.send(JSON.stringify({ type: "seerTurn", players: room.getDayVotingEligiblePlayers() }));
                }
            });
            return;
        }
    }

    advanceNightPhase(roomCode) {
        const room = this.roomManager.getRoom(roomCode);

        if (!room || !room.gameStarted) {
            return;
        }

        const nextPhase = room.advanceNightPhase();

        if (!nextPhase) {
            this.startDayPhase(roomCode);
            return;
        }

        this.sendCurrentNightTurn(room);
    }

    startDayPhase(roomCode) {
        const room = this.roomManager.getRoom(roomCode);

        if (!room || !room.gameStarted) {
            return;
        }

        const { diedPlayer, diedPlayers } = room.resolveNightOutcome();
        room.setDayPhase();

        this.sendPlayerList(room);
        this.sendRoomState(room);
        this.broadcast(room, {
            type: "wakeOrder",
            order: room.getWakeOrder()
        });
        this.broadcast(room, {
            type: "daySummary",
            victims: (diedPlayers || []).map((player) => ({
                id: player.id,
                username: player.name,
                nickname: player.nickname || player.name
            })),
            victim: diedPlayer
                ? {
                    id: diedPlayer.id,
                    username: diedPlayer.name,
                    nickname: diedPlayer.nickname || diedPlayer.name
                }
                : null
        });

        if (diedPlayers && diedPlayers.length > 0) {
            this.broadcast(room, {
                type: "info",
                message: `Amanece. Han muerto: ${diedPlayers.map((p) => p.nickname || p.name).join(", ")}.`
            });
        } else {
            this.broadcast(room, {
                type: "info",
                message: "Amanece. Nadie ha muerto durante la noche."
            });
        }

        const victoryAfterNight = room.checkVictory();
        if (victoryAfterNight.finished) {
            this.broadcast(room, { type: "gameFinished", message: victoryAfterNight.reason });
            return;
        }

        this.broadcast(room, {
            type: "voteStart",
            players: room.getDayVotingEligiblePlayers()
        });
    }

    resolveDayVotes(roomCode) {
        const room = this.roomManager.getRoom(roomCode);

        if (!room || !room.gameStarted || room.gamePhase !== "day") {
            return;
        }

        const result = room.resolveVotes();

        if (result.expelled) {
            this.sendRoomState(room);
            this.broadcast(room, {
                type: "voteResult",
                expelled: result.expelled
            });

            this.broadcast(room, {
                type: "info",
                message: `${result.expelled.nickname} fue expulsado y era ${result.expelled.role}.`
            });

            const victoryAfterVote = room.checkVictory();

            if (victoryAfterVote.finished) {
                this.broadcast(room, { type: "gameFinished", message: victoryAfterVote.reason });
                this.clearRoomTimer(roomCode);
                return;
            }
        } else {
            this.broadcast(room, { type: "voteResult", expelled: null, tied: true });
        }

        this.startNightPhase(roomCode);
    }

    startGameFlow(room) {
        room.gamePhase = "intro";
        this.sendRoomState(room);

        this.broadcast(room, {
            type: "gameCinematic",
            durationMs: 9000,
            title: "Historia inicial",
            text: "Dibujo animado: lobos persiguen a los aldeanos mientras el pueblo medieval cae en la oscuridad..."
        });

        this.setRoomTimer(room.code, () => this.startNightPhase(room.code), 9000);
    }

    removePlayerFromRoom(ws) {
        if (!ws.session || !ws.session.roomCode || !ws.session.playerId) {
            return;
        }

        const roomCode = ws.session.roomCode;
        const room = this.roomManager.getRoom(roomCode);

        if (!room) {
            delete ws.session.roomCode;
            delete ws.session.playerId;
            return;
        }

        room.removePlayer(ws.session.playerId);

        if (room.players.length === 0) {
            this.clearRoomTimer(roomCode);
            this.roomManager.deleteRoom(roomCode);
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

            if (!username || !email || !password) {
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
                ws.send(JSON.stringify({ type: "error", message: "Contrasena: minimo 6 caracteres" }));
                return;
            }

            const result = this.userManager.register(username, email, password);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            ws.send(JSON.stringify({ type: "registerSuccess", user: result.user }));
            return;
        }

        if (msg.type === "login") {
            const identifier = String(msg.username || "").trim();
            const password = String(msg.password || "").trim();

            if (!identifier || !password) {
                ws.send(JSON.stringify({ type: "error", message: "Usuario/email y contrasena requeridos" }));
                return;
            }

            const result = this.userManager.login(identifier, password);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            ws.session = { userId: result.user.userId, username: result.user.username };
            this.playerSessions.set(result.user.userId, ws);

            ws.send(JSON.stringify({ type: "loginSuccess", user: result.user }));
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
            const roomCode = String(msg.roomCode || "").trim().toUpperCase();

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
            ws.send(JSON.stringify({ type: "roomChatHistory", messages: room.chatMessages }));
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

            this.broadcast(room, { type: "roomChatMessage", message: result.message });
            return;
        }

        if (msg.type === "wolfNightChat") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.addWolfChatMessage(ws.session.userId, msg.text);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.sendToWolves(room, { type: "wolfChatMessage", message: result.message });
            return;
        }

        if (msg.type === "cupidoChoosePair") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);
            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.chooseCupidoPair(ws.session.userId, String(msg.firstPlayerId || "").trim(), String(msg.secondPlayerId || "").trim());
            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.broadcast(room, { type: "info", message: "Cupido ha elegido a los enamorados" });
            const progress = room.registerPhaseAction("night-first-cupid", ws.session.userId);
            if (progress.success && progress.completed) {
                this.advanceNightPhase(room.code);
            }
            return;
        }

        if (msg.type === "wildChildChooseModel") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);
            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.chooseWildChildModel(ws.session.userId, String(msg.modelPlayerId || "").trim());
            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.broadcast(room, { type: "info", message: "Niño Salvaje ya eligio su modelo" });
            const progress = room.registerPhaseAction("night-first-wildchild", ws.session.userId);
            if (progress.success && progress.completed) {
                this.advanceNightPhase(room.code);
            }
            return;
        }

        if (msg.type === "guardProtect") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);
            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.guardProtect(ws.session.userId, String(msg.targetPlayerId || "").trim());
            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            ws.send(JSON.stringify({ type: "info", message: "Has protegido a un jugador." }));
            const progress = room.registerPhaseAction("night-guard", ws.session.userId);
            if (progress.success && progress.completed) {
                this.advanceNightPhase(room.code);
            }
            return;
        }

        if (msg.type === "wolfSelectVictim") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const targetPlayerId = String(msg.targetPlayerId || "").trim();
            const result = room.wolfSelectVictim(ws.session.userId, targetPlayerId);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.sendToWolves(room, {
                type: "info",
                message: `${ws.session.username} ha elegido una victima.`
            });
            const progress = room.registerPhaseAction("night-wolves", ws.session.userId);
            if (progress.success && progress.completed) {
                this.advanceNightPhase(room.code);
            }
            return;
        }

        if (msg.type === "doctorDecision") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.doctorDecision(ws.session.userId, Boolean(msg.saveVictim));

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            const progress = room.registerPhaseAction("night-doctor", ws.session.userId);
            if (progress.success && progress.completed) {
                this.advanceNightPhase(room.code);
            }
            return;
        }

        if (msg.type === "witchAction") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);
            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.witchAction(ws.session.userId, {
                useHeal: Boolean(msg.useHeal),
                poisonTargetId: String(msg.poisonTargetId || "").trim()
            });

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            const progress = room.registerPhaseAction("night-witch", ws.session.userId);
            if (progress.success && progress.completed) {
                this.advanceNightPhase(room.code);
            }
            return;
        }

        if (msg.type === "seerInspect") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.inspectPlayer(ws.session.userId, String(msg.targetPlayerId || "").trim());

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            ws.send(JSON.stringify({ type: "seerResult", target: result.target }));
            const progress = room.registerPhaseAction("night-seer", ws.session.userId);
            if (progress.success && progress.completed) {
                this.advanceNightPhase(room.code);
            }
            return;
        }

        if (msg.type === "castVote") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const targetPlayerId = String(msg.targetPlayerId || "").trim();
            const result = room.castVote(ws.session.userId, targetPlayerId);

            if (!result.success) {
                console.log(`[VOTE FAILED] ${ws.session.userId} -> ${targetPlayerId}: ${result.message}`);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: "error", message: result.message }));
                }
                return;
            }

            console.log(`[VOTE SUCCESS] ${ws.session.userId} -> ${targetPlayerId} (${result.votesCount}/${result.aliveCount})`);
            
            // Siempre enviar confirmacion al votante
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "voteConfirmed", targetPlayerId: result.votedTargetId }));
            } else {
                console.log(`[VOTE WARNING] WebSocket no está listo (state: ${ws.readyState})`);
            }

            // Broadcast a todos del progreso
            this.broadcast(room, {
                type: "voteProgress",
                votesCount: result.votesCount,
                aliveCount: result.aliveCount
            });

            if (result.votesCount >= result.aliveCount) {
                console.log(`[VOTE COMPLETE] Todos votaron. Resolviendo en 500ms...`);
                this.clearRoomTimer(room.code);
                // Pequeño delay para asegurarse que todos reciben las confirmaciones
                setTimeout(() => this.resolveDayVotes(room.code), 500);
            } else {
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        type: "info",
                        message: `Votacion en curso: ${result.votesCount}/${result.aliveCount} votos emitidos.`
                    }));
                }
            }
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
                ws.send(JSON.stringify({ type: "error", message: "Solo puedes enviar solicitudes dentro de una sala o partida" }));
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

            this.sendPlayerList(room);
            this.broadcast(room, { type: "roomChatHistory", messages: [] });

            room.players.forEach((player) => {
                if (player.ws.readyState === 1) {
                    player.ws.send(JSON.stringify({
                        type: "gameStarted",
                        phase: room.gamePhase,
                        role: result.playerRoles[player.id] || "Aldeano"
                    }));
                }
            });

            this.startGameFlow(room);
            return;
        }

        if (msg.type === "endGame") {
            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

            if (!room) {
                ws.send(JSON.stringify({ type: "error", message: "No estas en una sala" }));
                return;
            }

            const result = room.endOrCancelGame(ws.session.userId, false);

            if (!result.success) {
                ws.send(JSON.stringify({ type: "error", message: result.message }));
                return;
            }

            this.clearRoomTimer(room.code);
            this.sendPlayerList(room);
            this.sendRoomState(room);
            this.broadcast(room, { type: "gameFinished", message: result.message });
            return;
        }

        if (msg.type === "kickPlayer") {
            const playerId = String(msg.playerId || "").trim();

            if (!ws.session) {
                ws.send(JSON.stringify({ type: "error", message: "Debes iniciar sesion" }));
                return;
            }

            const room = this.roomFromSession(ws);

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
        if (ws.session && ws.session.userId) {
            this.playerSessions.delete(ws.session.userId);
        }
        this.removePlayerFromRoom(ws);
    }
}

const lobby = new LobbyServer(wss);
lobby.start();
console.log("[SERVER] Servidor en puerto 3000");
