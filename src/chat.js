import { randomUUID } from "node:crypto";
import { AUTH_COOKIE } from "./accounts.js";

function readCookie(header, name) {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

const npcDialogue = {
  "npc-mara": ["Stay out of Iron Veil business and we won't have a problem.", "The docks remember who pays their debts."],
  "npc-vex": ["The Market has a price for everything. Ask the right person.", "Keep your crew out of North Crows territory."],
  "npc-sable": ["I've heard things. Most of them are expensive.", "Watch who you trust around the docks."],
};

export class ChatService {
  constructor(io, store, accounts) {
    this.io = io;
    this.store = store;
    this.accounts = accounts;
    this.messages = [];
    this.lastSentAt = new Map();

    io.use((socket, next) => {
      const token = readCookie(socket.handshake.headers.cookie, AUTH_COOKIE);
      const user = accounts.authenticate(token);
      if (!user) return next(new Error("Authentication required"));
      socket.data.user = user;
      next();
    });
    io.on("connection", (socket) => this.#connected(socket));
  }

  #connected(socket) {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    socket.join("channel:global");
    const world = this.store.read();
    for (const company of Object.values(world.companies)) {
      if (company.members.some((member) => member.playerId === user.id)) socket.join(`company:${company.id}`);
    }
    socket.emit("chat:history", this.messages.filter((message) => this.#canRead(user.id, message)).slice(-100));

    socket.on("chat:join", (companyId, ack = () => {}) => {
      const company = this.store.read().companies[companyId];
      if (!company?.members.some((member) => member.playerId === user.id)) return ack({ error: "Company membership required" });
      socket.join(`company:${companyId}`);
      ack({ ok: true });
    });

    socket.on("chat:send", (payload, ack = () => {}) => {
      const now = Date.now();
      if (now - (this.lastSentAt.get(user.id) ?? 0) < 700) return ack({ error: "Slow down before sending another message" });
      const text = String(payload?.text ?? "").trim().slice(0, 500);
      if (!text) return ack({ error: "Message cannot be empty" });
      const player = this.store.read().players[user.id];
      if (!player) return ack({ error: "Player profile not found" });
      const channel = payload?.channel;
      let recipientId = null;
      let companyId = null;
      if (channel === "company") {
        companyId = String(payload.companyId ?? "");
        const company = this.store.read().companies[companyId];
        if (!company?.members.some((member) => member.playerId === user.id)) return ack({ error: "Company membership required" });
      } else if (channel === "direct") {
        recipientId = String(payload.recipientId ?? "");
        if (recipientId !== user.id && !this.store.read().players[recipientId] && !this.store.read().npcs[recipientId]) return ack({ error: "Recipient not found" });
      } else if (channel !== "global") {
        return ack({ error: "Unknown chat channel" });
      }
      this.lastSentAt.set(user.id, now);
      const message = {
        id: randomUUID(), channel, companyId, recipientId,
        senderId: user.id, senderName: player.name, senderType: "player", text, timestamp: now,
      };
      this.#deliver(message);
      ack({ ok: true, message });

      const mention = Object.entries(npcDialogue).find(([id]) => {
        const npc = this.store.read().npcs[id];
        return npc && new RegExp(`\\b${npc.name.split(" ")[0]}\\b`, "i").test(text);
      });
      if (mention || (channel === "direct" && this.store.read().npcs[recipientId])) {
        const npcId = mention?.[0] ?? recipientId;
        const npc = this.store.read().npcs[npcId];
        const responses = npcDialogue[npcId];
        const reply = responses[Math.floor(Math.random() * responses.length)];
        setTimeout(() => {
          const npcMessage = {
            id: randomUUID(), channel, companyId, recipientId: channel === "direct" ? user.id : null,
            senderId: npcId, senderName: npc.name, senderType: "npc", text: reply, timestamp: Date.now(),
          };
          this.#deliver(npcMessage);
        }, 650);
      }
    });
  }

  #canRead(userId, message) {
    if (message.channel === "global") return true;
    if (message.channel === "direct") return message.senderId === userId || message.recipientId === userId;
    const company = this.store.read().companies[message.companyId];
    return Boolean(company?.members.some((member) => member.playerId === userId));
  }

  #deliver(message) {
    this.messages.push(message);
    if (this.messages.length > 500) this.messages.shift();
    if (message.channel === "global") this.io.to("channel:global").emit("chat:message", message);
    else if (message.channel === "company") this.io.to(`company:${message.companyId}`).emit("chat:message", message);
    else if (this.store.read().npcs[message.recipientId]) this.io.to(`user:${message.senderId}`).emit("chat:message", message);
    else this.io.to(`user:${message.senderId}`).to(`user:${message.recipientId}`).emit("chat:message", message);
  }

  broadcastNpcAlert(event) {
    const npc = this.store.read().npcs[event.npcId];
    if (!npc) return;
    const alertText = event.type === "attack_player"
      ? `${npc.name} struck ${event.targetName ?? "a player"} in ${npc.territory}.`
      : event.type === "attack_npc" || event.type === "attack_faction"
        ? `${npc.name} clashed with ${event.targetName ?? event.targetFaction ?? "a rival crew"}.`
        : event.type === "found_company"
          ? `${npc.name} registered a new company.`
          : `${npc.name} made a move: ${event.type.replaceAll("_", " ")}.`;
    const message = {
      id: randomUUID(), channel: "global", companyId: null, recipientId: null,
      senderId: npc.id, senderName: npc.name, senderType: "npc",
      text: alertText,
      timestamp: Date.now(),
    };
    this.#deliver(message);
  }
}
