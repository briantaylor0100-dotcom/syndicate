import { buyNpcAsset, foundNpcCompany } from "./companies.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const DISTRICT_NEIGHBORS = { docks: ["market"], market: ["docks"] };

function remember(npc, event, now) {
  npc.memory.push({ timestamp: now, ...event });
  if (npc.memory.length > 20) npc.memory.shift();
}

function distance(from, to) {
  if (from === to) return 0;
  return (DISTRICT_NEIGHBORS[from] ?? []).includes(to) ? 1 : 99;
}

function recentTargeted(npc, targetId, now) {
  return npc.memory.some((entry) => entry.targetId === targetId && now - entry.timestamp < 5 * 60_000);
}

/**
 * Utility policy: build candidate actions, score them against current needs and
 * choose the highest-scoring action. Every score is deterministic and visible
 * for debugging; an LLM can later propose candidates without owning game state.
 */
export function decideNpcAction(npc, world, now = Date.now()) {
  const candidates = [];
  const healthRatio = npc.health / Math.max(1, npc.maxHealth ?? 100);
  const gang = npc.gangId ? world.gangs[npc.gangId] : null;
  const order = npc.order ?? "survive";

  if (healthRatio <= 0.3) {
    candidates.push({ type: "retreat", score: 90 + (0.3 - healthRatio) * 100, reason: "critical_health" });
  }

  for (const player of Object.values(world.players)) {
    const range = distance(npc.territory, player.territory);
    if (range > 1 || player.health <= 0) continue;
    const intrusion = range === 0 && npc.territory === player.territory;
    const targetThreat = player.bounty / 5 + player.reputation / 15 + (player.inventory.weapon > 0 ? 8 : 0);
    const hostility = intrusion && npc.aggression >= 55 ? 24 : 0;
    const orderBonus = order === "protect territory" && intrusion ? 18 : 0;
    const fear = healthRatio < 0.45 ? 22 : 0;
    const score = npc.aggression * 0.45 + targetThreat + hostility + orderBonus - fear - range * 15;
    if ((targetThreat >= 5 || hostility > 0) && !recentTargeted(npc, player.id, now)) {
      candidates.push({ type: "attack_player", targetId: player.id, targetType: "player", score, reason: intrusion ? "territory_intrusion" : "wanted_target" });
    }
  }

  for (const rival of Object.values(world.npcs)) {
    if (rival.id === npc.id || rival.health <= 0 || distance(npc.territory, rival.territory) > 0) continue;
    const rivalGang = rival.gangId ? world.gangs[rival.gangId] : null;
    if (!gang || !rivalGang || gang.id === rivalGang.id) continue;
    const score = npc.aggression * 0.4 + rival.reputation * 0.3 + (order === "protect territory" ? 15 : 0) - (healthRatio < 0.5 ? 25 : 0);
    if (score >= 30 && !recentTargeted(npc, rival.id, now)) {
      candidates.push({ type: "attack_npc", targetId: rival.id, targetType: "npc", score, reason: "faction_rivalry" });
    }
  }

  for (const faction of Object.values(world.gangs)) {
    if (faction.id === npc.gangId || distance(npc.territory, faction.territory) > 0) continue;
    const member = faction.memberIds.map((id) => world.npcs[id]).find((candidate) => candidate && candidate.health > 0);
    if (!member) continue;
    const score = npc.aggression * 0.35 + faction.influence * 0.4 + (order === "protect territory" ? 14 : 0) - (healthRatio < 0.5 ? 25 : 0);
    if (score >= 32) candidates.push({ type: "attack_faction", targetId: faction.id, targetType: "faction", memberId: member.id, score, reason: "faction_territory_dispute" });
  }

  if (order === "avoid conflict") candidates.push({ type: "lay_low", score: 35 + (1 - healthRatio) * 20, reason: "current_order" });
  if (order === "collect intelligence") candidates.push({ type: "collect_intel", score: 34 + (npc.wealth < 250 ? 8 : 0), reason: "current_order" });
  if (order === "protect territory" && healthRatio > 0.3) candidates.push({ type: "patrol", score: 30 + (gang?.influence ?? 0) / 10, reason: "current_order" });
  if (npc.wealth >= 500 && !npc.companyId && (npc.reputation >= 35 || npc.wealth >= 700)) {
    candidates.push({ type: "found_company", score: 42 + npc.reputation / 5, reason: "wealth_and_influence" });
  }
  const npcCompany = npc.companyId ? world.companies[npc.companyId] : null;
  if (npcCompany && npcCompany.credits >= 250 && npcCompany.assets.length < 3) {
    candidates.push({ type: "invest_company", score: 40 + npcCompany.credits / 100, reason: "reinvest_treasury" });
  }
  const contractOffer = npcCompany && world.contracts.find((contract) => contract.toCompanyId === npcCompany.id && contract.status === "offered");
  if (contractOffer) {
    const income = npcCompany.assets.reduce((sum, asset) => sum + asset.incomePerMinute, 0);
    if (contractOffer.amountPerMinute <= income * 3 || npcCompany.credits >= contractOffer.amountPerMinute * 5) {
      candidates.push({ type: "sign_contract", targetId: contractOffer.id, score: 48, reason: "profitable_contract_offer" });
    }
  }
  if (!gang && npc.loyalty >= 75 && npc.reputation >= 60) candidates.push({ type: "create_gang", score: 45, reason: "independent_influence" });
  if (gang && npc.loyalty < 25) candidates.push({ type: "leave_gang", score: 80, reason: "low_loyalty" });
  if (!gang && npc.loyalty >= 65 && npc.reputation >= 20) {
    const candidate = Object.values(world.gangs).find((entry) => entry.territory === npc.territory);
    if (candidate) candidates.push({ type: "join_gang", gangId: candidate.id, score: 38, reason: "shared_territory" });
  }
  candidates.push({ type: "patrol", score: 10, reason: "routine" });
  return candidates.sort((a, b) => b.score - a.score)[0];
}

function resolveCombat(attacker, target) {
  const attackPower = attacker.strength * 2 + Math.floor(attacker.aggression / 3);
  const defense = target.stats
    ? target.stats.strength * 2 + target.stats.cunning
    : target.strength + Math.floor((target.aggression ?? 0) / 4);
  const attackerWon = attackPower >= defense;
  if (attackerWon) {
    const damage = Math.max(8, attackPower - defense + 12);
    target.health = Math.max(0, target.health - damage);
    attacker.reputation = clamp(attacker.reputation + 2, 0, 100);
    return { result: "attacker_won", damage };
  }
  attacker.health = Math.max(1, attacker.health - 10);
  attacker.reputation = clamp(attacker.reputation - 1, 0, 100);
  return { result: "attacker_lost", damage: 0 };
}

export function runNpcBehavior(npc, world, now = Date.now()) {
  if (npc.nextActionAt && now < npc.nextActionAt) return null;
  const decision = decideNpcAction(npc, world, now);
  let details = {};

  switch (decision.type) {
    case "attack_player": {
      const target = world.players[decision.targetId];
      if (!target) return null;
      const combat = resolveCombat(npc, target);
      if (combat.result === "attacker_won") target.bounty += 5;
      else target.reputation = clamp(target.reputation + 2, 0, 100);
      details = { ...combat, targetName: target.name };
      break;
    }
    case "attack_npc": {
      const target = world.npcs[decision.targetId];
      if (!target) return null;
      details = { ...resolveCombat(npc, target), targetName: target.name };
      break;
    }
    case "attack_faction": {
      const faction = world.gangs[decision.targetId];
      const target = faction && world.npcs[decision.memberId];
      if (!target) return null;
      details = { ...resolveCombat(npc, target), targetFaction: faction.name, targetName: target.name };
      break;
    }
    case "retreat":
      npc.territory = (DISTRICT_NEIGHBORS[npc.territory] ?? [npc.territory])[0];
      npc.health = Math.min(npc.maxHealth ?? 100, npc.health + 5);
      break;
    case "collect_intel":
      npc.wealth += 15;
      npc.reputation += 1;
      break;
    case "lay_low":
      npc.health = Math.min(npc.maxHealth ?? 100, npc.health + 3);
      break;
    case "found_company": {
      const company = foundNpcCompany(world, npc);
      if (company) details.companyId = company.id;
      break;
    }
    case "invest_company": {
      const asset = buyNpcAsset(world, npc);
      if (asset) details.assetName = asset.name;
      break;
    }
    case "sign_contract": {
      const contract = world.contracts.find((entry) => entry.id === decision.targetId && entry.status === "offered" && entry.toCompanyId === npc.companyId);
      if (contract) {
        contract.status = "active";
        contract.signedAt = now;
        contract.nextPaymentAt = now + 60_000;
        details.contractId = contract.id;
      }
      break;
    }
    case "leave_gang": {
      const oldGang = world.gangs[npc.gangId];
      if (oldGang) oldGang.memberIds = oldGang.memberIds.filter((id) => id !== npc.id);
      npc.gangId = null;
      npc.loyalty = clamp(npc.loyalty + 5, 0, 100);
      break;
    }
    case "join_gang":
      npc.gangId = decision.gangId;
      world.gangs[decision.gangId].memberIds.push(npc.id);
      npc.loyalty = clamp(npc.loyalty + 3, 0, 100);
      break;
    case "create_gang": {
      const id = `gang-${npc.id}`;
      world.gangs[id] = { id, name: `${npc.name.split(" ")[0]}'s Crew`, territory: npc.territory, memberIds: [npc.id], influence: 5 };
      npc.gangId = id;
      npc.loyalty = 80;
      break;
    }
    case "patrol":
    default:
      npc.reputation = clamp(npc.reputation + 1, 0, 100);
  }

  npc.nextActionAt = now + (["attack_player", "attack_npc", "attack_faction"].includes(decision.type) ? 5 : 10) * 60_000;
  npc.xp = (npc.xp ?? 0) + 10;
  while (npc.xp >= (npc.level ?? 1) * 100) {
    npc.xp -= (npc.level ?? 1) * 100;
    npc.level = (npc.level ?? 1) + 1;
    npc.strength += 1;
    npc.maxHealth = (npc.maxHealth ?? 100) + 3;
    npc.health = clamp(npc.health + 3, 0, npc.maxHealth);
  }
  const event = { npcId: npc.id, ...decision, ...details, level: npc.level ?? 1 };
  remember(npc, event, now);
  return event;
}
