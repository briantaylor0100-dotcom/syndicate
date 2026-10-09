let PLAYER_ID;
const RESOURCE_LABELS = { ore: "Ore", wood: "Timber", intel: "Street intel", contraband: "Unmarked stock", weapon: "Weapons", street_goods: "Street goods" };
const NODE_LABELS = { scrapyard: "The scrapyard", lumberyard: "The lumberyard", backchannels: "Backchannel contacts", safehouse: "The safehouse" };
const DISTRICTS = {
  docks: { title: "The Docks", tag: "INDUSTRIAL", description: "Cold water, hot cargo, and people who ask fewer questions." },
  market: { title: "The Market", tag: "COMMERCIAL", description: "A bright district with dark business behind every shutter." },
};

const $ = (id) => document.getElementById(id);
let state;
let busy = false;
let toastTimer;
let localFeed = [];
const seenNpcEvents = new Set();
let currentUser;
let playerDirectory = [];
let socket;
let chatHistory = [];

function player() { return state.players[PLAYER_ID]; }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2300);
}
function record(message) {
  localFeed.unshift({ message, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
  localFeed = localFeed.slice(0, 8);
}
async function request(path, body) {
  const response = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The action failed.");
  return data;
}
async function refresh() {
  state = await request("/api/state");
  for (const event of state.events) {
    if (!event.npcId) continue;
    const signature = `${event.timestamp}:${event.npcId}`;
    if (seenNpcEvents.has(signature)) continue;
    seenNpcEvents.add(signature);
    const npc = state.npcs[event.npcId]?.name ?? "A local rival";
    record(`${npc}: ${describeNpcAction(event)}.`);
  }
  renderCompanies();
  renderChatTargets();
  render();
}
async function act(action, successMessage) {
  if (busy) return;
  busy = true;
  render();
  try {
    const result = await request("/api/actions", { playerId: PLAYER_ID, ...action });
    record(successMessage(result));
    await refresh();
    showToast(successMessage(result));
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
    render();
  }
}

function render() {
  if (!state) return;
  const me = player();
  const district = DISTRICTS[me.territory] ?? DISTRICTS.docks;
  $("player-name").textContent = me.name.toUpperCase();
  document.querySelector(".avatar").textContent = me.name[0].toUpperCase();
  $("account-name").textContent = `@${currentUser.username}`;
  $("player-location").textContent = district.title.toUpperCase();
  $("district-title").textContent = district.title;
  $("district-description").textContent = district.description;
  $("district-tag").textContent = district.tag;
  $("level-value").textContent = String(me.level).padStart(2, "0");
  const xpGoal = me.level * 100;
  $("xp-label").textContent = `${me.xp} / ${xpGoal} XP`;
  $("xp-fill").style.width = `${Math.min(100, me.xp / xpGoal * 100)}%`;
  $("energy-value").textContent = me.energy;
  $("energy-fill").style.width = `${me.energy}%`;
  $("nerve-value").textContent = me.nerve;
  $("nerve-fill").style.width = `${me.nerve}%`;
  $("health-value").textContent = me.health;
  $("health-fill").style.width = `${me.health}%`;
  $("rep-value").textContent = String(me.reputation).padStart(2, "0");
  $("rep-fill").style.width = `${me.reputation}%`;
  $("bounty-value").textContent = `$${me.bounty}`;
  $("credits-value").textContent = `$${me.credits.toLocaleString()}`;
  updateResourceTimers(me);
  renderTravel(me);
  renderNodes(me);
  renderRecipes(me);
  renderTraining(me);
  renderInventory(me);
  renderPeople();
  renderFeed();
  renderChat();
}

function countdown(timestamp, interval, gain, current, cap) {
  if (current >= cap) return `FULL · +${gain} / ${interval / 60_000} MIN`;
  const elapsed = Math.max(0, Date.now() - timestamp);
  const remaining = Math.ceil((interval - (elapsed % interval)) / 1000);
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, "0");
  return `+${gain} IN ${minutes}:${seconds} · ${gain} / ${interval / 60_000} MIN`;
}

function updateResourceTimers(me) {
  $("energy-timer").textContent = countdown(me.energyUpdatedAt, 15 * 60_000, 5, me.energy, 100);
  $("nerve-timer").textContent = countdown(me.nerveUpdatedAt, 5 * 60_000, 1, me.nerve, 100);
}

function renderTravel(me) {
  $("travel-options").innerHTML = Object.entries(DISTRICTS).map(([id, district]) => {
    const current = id === me.territory;
    return `<button class="travel-button ${current ? "active" : ""}" data-travel="${id}" ${current || busy ? "disabled" : ""}>${current ? "● " : "↗ "}${district.title.toUpperCase()}${current ? " · HERE" : ""}</button>`;
  }).join("");
}

function renderNodes(me) {
  const entries = Object.entries(state.nodes).filter(([, node]) => node.territory === me.territory);
  $("node-list").innerHTML = entries.map(([id, node]) => {
    const resource = RESOURCE_LABELS[node.resource] ?? node.resource;
    return `<div class="node-row"><div><div class="node-name">${NODE_LABELS[id] ?? id}</div><div class="node-resource">${resource} · ${node.stock} left</div></div><div class="node-meta">5 NERVE</div><button class="gather-button" data-gather="${id}" ${busy || node.stock < 1 || me.nerve < 5 ? "disabled" : ""}>SCAVENGE ↗</button></div>`;
  }).join("") || `<div class="feed-empty">No active resource nodes in this district.</div>`;
}

function renderRecipes(me) {
  const recipes = [
    { id: "weapon", name: "Workshop weapon", input: "3 Ore", output: "+1 weapon", risk: "LOW HEAT · +3 reputation", short: "Make a weapon" },
    { id: "street_goods", name: "Street goods", input: "2 Unmarked stock", output: "+1 street goods", risk: "HIGH HEAT · +8 reputation", short: "Make street goods" },
  ];
  $("recipe-list").innerHTML = recipes.map((recipe) => {
    const affordable = recipe.id === "weapon" ? me.inventory.ore >= 3 : me.inventory.contraband >= 2;
    return `<div class="recipe-card"><div class="recipe-title">${recipe.name}</div><div class="recipe-meta">INPUT ${recipe.input}<br>OUTPUT ${recipe.output}<br>${recipe.risk}<br>COST 10 NERVE</div><div class="recipe-footer"><span class="node-meta">${affordable && me.nerve >= 10 ? "READY" : !affordable ? "GATHER INPUTS" : "NEED NERVE"}</span><button class="action-button" data-produce="${recipe.id}" ${busy || !affordable || me.nerve < 10 ? "disabled" : ""}>${recipe.short.toUpperCase()}</button></div></div>`;
  }).join("");
}

function renderTraining(me) {
  $("training-list").innerHTML = Object.entries(me.stats).filter(([stat]) => stat === "strength" || stat === "cunning").map(([stat, value]) => {
    const cost = 10 + value * 2;
    const resource = "energy";
    const available = me[resource] >= cost;
    return `<div class="training-card"><strong>${escapeHtml(stat)}</strong><small>RANK ${String(value).padStart(2, "0")} · ${cost} ${resource.toUpperCase()}</small><button class="action-button" data-train="${stat}" ${busy || !available ? "disabled" : ""}>TRAIN +1</button></div>`;
  }).join("");
}

function renderInventory(me) {
  const items = Object.entries(me.inventory).filter(([, count]) => count > 0);
  const count = Object.values(me.inventory).reduce((sum, value) => sum + value, 0);
  $("inventory-count").textContent = `${count} ITEM${count === 1 ? "" : "S"}`;
  $("inventory-list").innerHTML = items.length ? items.map(([id, amount]) => `<div class="inventory-row"><span>${RESOURCE_LABELS[id] ?? escapeHtml(id)}</span><strong>${amount}</strong></div>`).join("") : `<div class="feed-empty">Your pockets are empty. Find a node and get to work.</div>`;
}

function renderPeople() {
  const npcs = Object.values(state.npcs);
  $("people-list").innerHTML = npcs.map((npc) => {
    const gang = npc.gangId ? state.gangs[npc.gangId]?.name ?? "Independent" : "Independent";
    const initials = npc.name.split(" ").map((part) => part[0]).slice(0, 2).join("");
    const here = npc.territory === player().territory;
    const status = npc.health <= 0 ? "DOWN" : here ? `HP ${npc.health}` : npc.territory.toUpperCase();
    return `<div class="person-row"><div class="person-avatar">${escapeHtml(initials)}</div><div class="person-details"><div class="person-name">${escapeHtml(npc.name)}</div><div class="person-meta">LVL ${npc.level ?? 1} · ${escapeHtml(gang)} · ${status}</div></div>${here ? `<button class="attack-button" data-attack="${npc.id}" ${busy || npc.health <= 0 || player().energy < 25 ? "disabled" : ""}>${npc.health <= 0 ? "DOWN" : "FIGHT · 25E"}</button>` : ""}</div>`;
  }).join("");
}

async function companyAction(payload, successText = "Company records updated.") {
  if (busy) return null;
  busy = true;
  try {
    const result = await request("/api/companies/actions", payload);
    record(successText);
    await refresh();
    showToast(successText);
    return result;
  } catch (error) {
    showToast(error.message);
    return null;
  } finally {
    busy = false;
    render();
  }
}

function renderCompanies() {
  if (!state) return;
  const me = player();
  const companies = state.companies ?? [];
  const myCompanies = companies.filter((company) => company.members.some((member) => member.playerId === PLAYER_ID));
  const otherCompanies = companies.filter((company) => !myCompanies.includes(company));
  let html = "";
  if (!myCompanies.length) {
    html += `<form id="company-create-form" class="company-create"><p>Found a syndicate for 500 credits. Your company starts with 60% ownership and a 500 credit treasury.</p><input name="companyName" minlength="3" maxlength="32" placeholder="Company name" required><button class="action-button" ${me.credits < 500 ? "disabled" : ""}>FOUND COMPANY · 500 CR</button></form>`;
  }
  for (const company of myCompanies) {
    const member = company.members.find((entry) => entry.playerId === PLAYER_ID);
    const ownPercent = Math.floor(member.shares / company.totalShares * 100);
    const signed = company.contracts ?? [];
    const assets = company.assets.map((asset) => `<span class="asset-chip">${escapeHtml(asset.name)} <b>+${asset.incomePerMinute}/min</b></span>`).join("") || `<span class="muted">No income assets yet.</span>`;
    const memberList = company.members.map((entry) => `<span>${escapeHtml(entry.name)} <small>${escapeHtml(entry.role)} · ${Math.floor(entry.shares / company.totalShares * 100)}%</small>${company.canManage && entry.role !== "ceo" ? `<button class="text-button inline-member-action" data-company-action="promote" data-company-id="${company.id}" data-target-id="${entry.playerId}" data-role="${entry.role === "cfo" ? "employee" : "cfo"}">${entry.role === "cfo" ? "DEMOTE" : "MAKE CFO"}</button><input class="wage-input" data-target-id="${entry.playerId}" type="number" min="0" max="100" value="${entry.wagePerMinute}" aria-label="Wage per minute"><button class="text-button inline-member-action" data-company-action="set_wage" data-company-id="${company.id}" data-target-id="${entry.playerId}">SET WAGE</button>` : ""}</span>`).join("");
    const pending = signed.filter((contract) => contract.status === "offered" && contract.toCompanyId === company.id).map((contract) => `<div class="contract-row">Offer · ${escapeHtml(companyName(contract.fromCompanyId))} pays ${contract.amountPerMinute}/min <button class="text-button" data-company-action="sign_contract" data-company-id="${company.id}" data-contract-id="${contract.id}">SIGN</button></div>`).join("");
    const contractStatus = signed.filter((contract) => contract.status === "active" || (contract.status === "offered" && contract.fromCompanyId === company.id)).map((contract) => `<div class="contract-row">${contract.status === "active" ? "ACTIVE" : "OFFERED"} · ${escapeHtml(companyName(contract.fromCompanyId === company.id ? contract.toCompanyId : contract.fromCompanyId))} · ${contract.amountPerMinute}/min ${contract.status === "active" ? `<button class="text-button" data-company-action="cancel_contract" data-company-id="${company.id}" data-contract-id="${contract.id}">CANCEL</button>` : ""}</div>`).join("");
    const tools = company.canManage ? `
      <div class="company-tools">
        <div class="company-tool-row"><span>BUY ASSET</span><button class="text-button" data-company-action="buy_asset" data-company-id="${company.id}" data-asset-type="kiosk">KIOSK · 250</button><button class="text-button" data-company-action="buy_asset" data-company-id="${company.id}" data-asset-type="workshop">WORKSHOP · 750</button><button class="text-button" data-company-action="buy_asset" data-company-id="${company.id}" data-asset-type="data_vault">DATA VAULT · 1500</button></div>
        <div class="company-tool-row"><span>INVITE PLAYER</span><select class="invite-target" data-company-id="${company.id}">${playerDirectory.filter((entry) => entry.id !== PLAYER_ID && !company.members.some((m) => m.playerId === entry.id)).map((entry) => `<option value="${entry.id}">${escapeHtml(entry.name)}</option>`).join("")}</select><button class="text-button" data-company-action="invite_member" data-company-id="${company.id}">INVITE</button></div>
        <div class="company-tool-row"><span>CONTRACT</span><select class="contract-target" data-company-id="${company.id}">${otherCompanies.map((entry) => `<option value="${entry.id}">${escapeHtml(entry.name)}</option>`).join("")}</select><input class="contract-amount" data-company-id="${company.id}" type="number" min="1" value="10" aria-label="Credits per minute"><button class="text-button" data-company-action="offer_contract" data-company-id="${company.id}" ${otherCompanies.length ? "" : "disabled"}>OFFER / MIN</button></div>
      </div>` : "";
    html += `<article class="company-card"><div class="company-card-head"><div><div class="eyebrow">${escapeHtml(member.role.toUpperCase())} · ${ownPercent}% OWNERSHIP</div><h3>${escapeHtml(company.name)}</h3></div><div class="company-cash">${company.credits.toLocaleString()}<small>CR</small></div></div><div class="company-assets">${assets}</div><div class="company-members">${memberList}</div><div class="company-invest"><button class="text-button" data-company-action="deposit" data-company-id="${company.id}">DEPOSIT 100 CR</button><button class="text-button" data-company-action="buy_shares" data-company-id="${company.id}">BUY 10 SHARES · 250 CR</button></div>${pending}${contractStatus}${tools}</article>`;
  }
  if (!myCompanies.length && companies.length) html += `<div class="public-company-list"><span class="eyebrow">ACTIVE FIRMS</span>${companies.map((entry) => `<span>${escapeHtml(entry.name)} · ${entry.territory}</span>`).join("")}</div>`;
  $("company-content").innerHTML = html;
}

function companyName(id) { return state.companies?.find((company) => company.id === id)?.name ?? "a company"; }

function renderChatTargets() {
  const channel = $("chat-channel");
  const target = $("chat-target");
  if (!channel || !state) return;
  const mode = channel.value;
  const oldSelection = target.value;
  target.classList.toggle("hidden", mode === "global");
  if (mode === "company") {
    const companyOptions = (state.companies ?? []).filter((company) => company.members.some((member) => member.playerId === PLAYER_ID));
    target.innerHTML = companyOptions.map((company) => `<option value="${company.id}">${escapeHtml(company.name)}</option>`).join("");
    if (companyOptions.some((company) => company.id === oldSelection)) target.value = oldSelection;
    if (socket?.connected && target.value) socket.emit("chat:join", target.value);
  } else if (mode === "direct") {
    const options = [
      ...playerDirectory.filter((entry) => entry.id !== PLAYER_ID).map((entry) => [entry.id, `${entry.name} · player`]),
      ...Object.values(state.npcs).map((npc) => [npc.id, `${npc.name} · NPC`]),
    ];
    target.innerHTML = options.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("");
    if (options.some(([id]) => id === oldSelection)) target.value = oldSelection;
  }
  renderChat();
}

function renderChat() {
  if (!state || !$("chat-messages")) return;
  const channel = $("chat-channel").value;
  const selected = $("chat-target").value;
  const visible = chatHistory.filter((message) => {
    if (message.channel !== channel) return false;
    if (channel === "company") return message.companyId === selected;
    if (channel === "direct") return message.senderId === selected || message.recipientId === selected || ((message.senderId === PLAYER_ID || message.recipientId === PLAYER_ID) && (message.senderId === selected || message.recipientId === selected));
    return true;
  }).slice(-60);
  $("chat-messages").innerHTML = visible.map((message) => `<div class="chat-message ${message.senderType === "npc" ? "npc-message" : ""}"><div><strong>${escapeHtml(message.senderName)}</strong><time>${new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>${escapeHtml(message.text)}</p></div>`).join("") || `<div class="feed-empty">No messages here yet. Say something.</div>`;
  $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
}

function renderFeed() {
  $("activity-feed").innerHTML = localFeed.length ? localFeed.map((item) => `<div class="feed-item"><time>${escapeHtml(item.time)}</time>${escapeHtml(item.message)}</div>`).join("") : `<div class="feed-empty">The city is quiet. For now.<br>Take an action to get things moving.</div>`;
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.gather) {
    const id = target.dataset.gather;
    const node = state.nodes[id];
    await act({ type: "gather", node: id, resource: node.resource }, (result) => `Scavenged ${result.event.amount} ${RESOURCE_LABELS[result.event.resource]}.`);
  } else if (target.dataset.travel) {
    const place = target.dataset.travel;
    await act({ type: "travel", territory: place }, () => `Moved to ${DISTRICTS[place].title}.`);
  } else if (target.dataset.produce) {
    const product = target.dataset.produce;
    await act({ type: "produce", product }, (result) => `Produced ${result.event.output[product]} ${RESOURCE_LABELS[product]}. Heat is rising.`);
  } else if (target.dataset.train) {
    const stat = target.dataset.train;
    await act({ type: "train", stat }, (result) => `${stat[0].toUpperCase()}${stat.slice(1)} increased to ${result.event.value}.`);
  } else if (target.dataset.attack) {
    const npc = state.npcs[target.dataset.attack];
    await act({ type: "attack", targetId: npc.id }, (result) => result.event.won
      ? `You hit ${result.event.targetName} for ${result.event.damage}. They have ${result.event.targetHealth} health left.`
      : `${result.event.targetName} turned the attack around. You lost 10 health and picked up a bounty.`);
  } else if (target.dataset.companyAction) {
    const companyId = target.dataset.companyId;
    const type = target.dataset.companyAction;
    let payload = { companyId, type };
    let message = "Company records updated.";
    if (type === "buy_asset") {
      payload.assetType = target.dataset.assetType;
      message = `Purchased a ${target.dataset.assetType.replaceAll("_", " ")}.`;
    } else if (type === "deposit") {
      payload.amount = 100;
      message = "Deposited 100 credits into the company treasury.";
    } else if (type === "buy_shares") {
      payload.amount = 10;
      message = "Purchased 10 company shares.";
    } else if (type === "invite_member") {
      payload.targetPlayerId = document.querySelector(`.invite-target[data-company-id="${companyId}"]`)?.value;
      if (!payload.targetPlayerId) return showToast("No other player is available to invite.");
      message = "Player added to the company.";
    } else if (type === "set_wage") {
      payload.targetPlayerId = target.dataset.targetId;
      payload.amount = Number(document.querySelector(`.wage-input[data-target-id="${payload.targetPlayerId}"]`)?.value);
      message = `Set wage to ${payload.amount} credits per minute.`;
    } else if (type === "promote") {
      payload.targetPlayerId = target.dataset.targetId;
      payload.role = target.dataset.role;
      message = `Member role changed to ${payload.role.toUpperCase()}.`;
    } else if (type === "offer_contract") {
      payload.counterpartyCompanyId = document.querySelector(`.contract-target[data-company-id="${companyId}"]`)?.value;
      payload.amount = Number(document.querySelector(`.contract-amount[data-company-id="${companyId}"]`)?.value);
      if (!payload.counterpartyCompanyId) return showToast("Create another company before offering a contract.");
      message = "Contract offer sent for approval.";
    } else if (type === "sign_contract") {
      payload.contractId = target.dataset.contractId;
      message = "Contract signed. Payments now run every minute.";
    } else if (type === "cancel_contract") {
      payload.contractId = target.dataset.contractId;
      message = "Recurring contract cancelled.";
    }
    await companyAction(payload, message);
  }
});

$("company-content").addEventListener("submit", async (event) => {
  if (event.target.id !== "company-create-form") return;
  event.preventDefault();
  const name = new FormData(event.target).get("companyName");
  try {
    const result = await request("/api/companies", { name });
    record(`Founded ${result.company.name}.`);
    await refresh();
    showToast(`${result.company.name} is now registered.`);
  } catch (error) { showToast(error.message); }
});

$("chat-channel").addEventListener("change", () => {
  renderChatTargets();
  if ($("chat-channel").value === "company" && socket && $("chat-target").value) socket.emit("chat:join", $("chat-target").value);
});
$("chat-target").addEventListener("change", renderChat);
$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!socket?.connected) return showToast("Chat connection is offline.");
  const channel = $("chat-channel").value;
  const payload = { channel, text: $("chat-input").value };
  if (channel === "company") payload.companyId = $("chat-target").value;
  if (channel === "direct") payload.recipientId = $("chat-target").value;
  socket.emit("chat:send", payload, (result) => {
    if (result?.error) return showToast(result.error);
    $("chat-input").value = "";
  });
});

$("logout").addEventListener("click", async () => {
  await request("/api/logout", {});
  window.location.assign("/");
});

function describeNpcAction(action) {
  const npc = state.npcs[action.npcId]?.name ?? "Someone";
  if (action.type === "attack_player") return `${npc} attacked ${action.targetName ?? "a player"}${action.result === "attacker_won" ? ` for ${action.damage} damage` : " and was repelled"}`;
  if (action.type === "attack_npc" || action.type === "attack_faction") return `${npc} clashed with ${action.targetName ?? action.targetFaction ?? "a rival"}`;
  if (action.type === "retreat") return `${npc} withdrew to ${state.npcs[action.npcId]?.territory}`;
  if (action.type === "found_company") return `${npc} founded a company`;
  if (action.type === "collect_intel") return `${npc} gathered intelligence`;
  if (action.type === "lay_low") return `${npc} is keeping a low profile`;
  if (action.type === "place_bounty") return `${npc} put money on your name`;
  if (action.type === "join_gang") return `${npc} joined ${state.gangs[action.gangId]?.name ?? "a gang"}`;
  if (action.type === "leave_gang") return `${npc} left their gang`;
  if (action.type === "create_gang") return `${npc} started a new crew`;
  return `${npc} made their rounds`;
}

async function boot() {
  const auth = await request("/api/me");
  currentUser = auth.user;
  PLAYER_ID = currentUser.id;
  playerDirectory = await request("/api/players");
  await refresh();
  socket = io();
  socket.on("chat:history", (messages) => { chatHistory = messages; renderChat(); });
  socket.on("chat:message", (message) => {
    if (!chatHistory.some((item) => item.id === message.id)) chatHistory.push(message);
    chatHistory = chatHistory.slice(-500);
    renderChat();
  });
  socket.on("connect_error", () => showToast("Chat disconnected. Reload after signing in again."));
  setInterval(async () => {
    try { playerDirectory = await request("/api/players"); await refresh(); }
    catch { /* Session expiry is handled by the next explicit action. */ }
  }, 30_000);
}

boot().catch(() => window.location.replace("/"));

setInterval(() => { if (state) updateResourceTimers(player()); }, 1000);
setInterval(() => refresh().catch(() => {}), 10_000);
