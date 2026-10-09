import { runNpcBehavior } from "./npc.js";
import { advanceCompanyEconomy, createCompany, performCompanyAction, visibleCompanies } from "./companies.js";

const RESOURCE_TYPES = new Set(["ore", "wood", "intel", "contraband"]);
export const RESOURCE_REGEN = { energy: 5, energyIntervalMs: 15 * 60_000, nerve: 1, nerveIntervalMs: 5 * 60_000, maxEnergy: 100, maxNerve: 100 };
const GATHER_NERVE_COST = 5;
const PRODUCTION_NERVE_COST = 10;
const ATTACK_ENERGY_COST = 25;
const RECIPES = {
  weapon: { inputs: { ore: 3 }, output: { weapon: 1 }, risk: 3, xp: 12 },
  street_goods: { inputs: { contraband: 2 }, output: { street_goods: 1 }, risk: 8, xp: 15 },
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const fail = (message, status = 400) => ({ error: message, status });

export function createInitialWorld() {
  const now = Date.now();
  return {
    updatedAt: now,
    players: {},
    gangs: {
      "iron-veil": { id: "iron-veil", name: "Iron Veil", territory: "docks", memberIds: ["npc-mara"], influence: 22 },
      "north-crows": { id: "north-crows", name: "North Crows", territory: "market", memberIds: ["npc-vex"], influence: 18 },
    },
    npcs: {
      "npc-mara": { id: "npc-mara", name: "Mara Venn", territory: "docks", targetPlayerId: null, gangId: "iron-veil", loyalty: 72, reputation: 35, aggression: 62, strength: 12, health: 100, maxHealth: 100, level: 1, xp: 0, wealth: 350, order: "protect territory", memory: [] },
      "npc-vex": { id: "npc-vex", name: "Vex Calder", territory: "market", targetPlayerId: null, gangId: "north-crows", loyalty: 48, reputation: 42, aggression: 35, strength: 10, health: 100, maxHealth: 100, level: 1, xp: 0, wealth: 700, order: "collect intelligence", memory: [] },
      "npc-sable": { id: "npc-sable", name: "Sable Quinn", territory: "docks", targetPlayerId: null, gangId: null, loyalty: 66, reputation: 23, aggression: 28, strength: 8, health: 100, maxHealth: 100, level: 1, xp: 0, wealth: 120, order: "avoid conflict", memory: [] },
    },
    nodes: {
      scrapyard: { territory: "docks", resource: "ore", stock: 30 },
      lumberyard: { territory: "market", resource: "wood", stock: 30 },
      backchannels: { territory: "market", resource: "intel", stock: 20 },
      safehouse: { territory: "docks", resource: "contraband", stock: 20 },
    },
    companies: {},
    contracts: [],
    companyTransactions: [],
    companyUpdatedAt: now,
    events: [],
  };
}

export class GameEngine {
  constructor(store) {
    this.store = store;
  }

  createPlayer(account) {
    return this.store.update((world) => {
      if (!world.players[account.id]) {
        const now = Date.now();
        world.players[account.id] = {
          id: account.id, name: account.username, territory: "docks", gangId: null,
          level: 1, xp: 0, health: 100, energy: 100, nerve: 100, energyUpdatedAt: now, nerveUpdatedAt: now,
          reputation: 5, bounty: 0, credits: 1_000,
          stats: { strength: 5, cunning: 5, influence: 5 },
          inventory: { ore: 2, wood: 2, intel: 0, contraband: 0, weapon: 0, street_goods: 0 },
          factories: { weapon: 0, street_goods: 0 },
        };
      }
      return world.players[account.id];
    });
  }

  getState(playerId) {
    return this.store.update((world) => {
      const now = Date.now();
      const player = world.players[playerId];
      if (player) this.#replenish(player, now);
      advanceCompanyEconomy(world, now);
      world.updatedAt = now;
      const view = structuredClone(world);
      view.players = player ? { [playerId]: structuredClone(player) } : {};
      view.companies = visibleCompanies(world, playerId);
      view.events = world.events.filter((event) => event.playerId === playerId || event.npcId).slice(-100);
      return view;
    });
  }

  listPlayers() {
    return Object.values(this.store.read().players).map(({ id, name, territory }) => ({ id, name, territory }));
  }

  foundCompany(playerId, name) {
    return this.store.update((world) => createCompany(world, playerId, name));
  }

  companyAction(playerId, payload) {
    return this.store.update((world) => performCompanyAction(world, playerId, payload));
  }

  #ensureEconomy(world, now) {
    advanceCompanyEconomy(world, now);
  }

  performAction(action) {
    return this.store.update((world) => {
      const player = world.players[action.playerId];
      if (!player) return fail("Player not found", 404);
      const now = Date.now();
      this.#replenish(player, now);
      let result;

      if (action.type === "gather") {
        const node = world.nodes[action.node];
        if (!node) return fail("Resource node not found", 404);
        if (node.resource !== action.resource || !RESOURCE_TYPES.has(action.resource)) return fail("That resource is not available at this node");
        if (node.territory !== player.territory) return fail("You are outside your territory");
        if (node.stock < 1) return fail("This node is depleted");
        if (player.nerve < GATHER_NERVE_COST) return fail(`Need ${GATHER_NERVE_COST} nerve to scavenge`);
        const amount = Math.min(3, node.stock);
        player.nerve -= GATHER_NERVE_COST;
        node.stock -= amount;
        player.inventory[action.resource] = (player.inventory[action.resource] ?? 0) + amount;
        player.xp += amount;
        result = { type: "gather", resource: action.resource, amount, node: action.node };
      } else if (action.type === "travel") {
        if (!["docks", "market"].includes(action.territory)) return fail("Unknown district");
        if (action.territory === player.territory) return fail("You are already in that district");
        player.territory = action.territory;
        result = { type: "travel", territory: action.territory };
      } else if (action.type === "attack") {
        const npc = world.npcs[action.targetId];
        if (!npc) return fail("Target not found", 404);
        if (npc.territory !== player.territory) return fail(`That rival is in ${npc.territory}`);
        if (npc.health <= 0) return fail("That rival is already out of the fight");
        if (player.energy < ATTACK_ENERGY_COST) return fail(`Need ${ATTACK_ENERGY_COST} energy to attack`);
        player.energy -= ATTACK_ENERGY_COST;
        const weaponBonus = Math.min(player.inventory.weapon, 3) * 10;
        const attackPower = player.stats.strength * 2 + player.stats.cunning + weaponBonus;
        const defense = npc.strength + Math.floor(npc.aggression / 4);
        const won = attackPower >= defense;
        if (won) {
          const damage = Math.max(8, attackPower - defense + 12);
          npc.health = Math.max(0, npc.health - damage);
          player.reputation = clamp(player.reputation + 2, 0, 100);
          player.xp += 10;
        } else {
          player.health = Math.max(1, player.health - 10);
          player.bounty += 5;
          npc.reputation += 2;
        }
        result = { type: "attack", targetId: npc.id, targetName: npc.name, won, damage: won ? Math.max(8, attackPower - defense + 12) : 0, targetHealth: npc.health, energyCost: ATTACK_ENERGY_COST };
      } else if (action.type === "produce") {
        const recipe = RECIPES[action.product];
        if (!recipe) return fail("Unknown product");
        if (player.nerve < PRODUCTION_NERVE_COST) return fail(`Need ${PRODUCTION_NERVE_COST} nerve to produce items`);
        for (const [resource, amount] of Object.entries(recipe.inputs)) {
          if ((player.inventory[resource] ?? 0) < amount) return fail(`Need ${amount} ${resource}`);
        }
        player.nerve -= PRODUCTION_NERVE_COST;
        for (const [resource, amount] of Object.entries(recipe.inputs)) player.inventory[resource] -= amount;
        for (const [product, amount] of Object.entries(recipe.output)) player.inventory[product] = (player.inventory[product] ?? 0) + amount;
        player.factories[action.product] = (player.factories[action.product] ?? 0) + 1;
        player.reputation = clamp(player.reputation + recipe.risk, 0, 100);
        player.bounty += Math.floor(recipe.risk / 2);
        player.xp += recipe.xp;
        result = { type: "produce", product: action.product, output: recipe.output, risk: recipe.risk };
      } else if (action.type === "train") {
        const stat = action.stat;
        if (!["strength", "cunning"].includes(stat)) return fail("Only battle stats can be trained");
        const cost = 10 + player.stats[stat] * 2;
        const resource = "energy";
        if (player[resource] < cost) return fail(`Need ${cost} ${resource} to train ${stat}`);
        player[resource] -= cost;
        player.stats[stat] += 1;
        result = { type: "train", stat, value: player.stats[stat], cost, resource };
      } else {
        return fail("Unknown action type");
      }

      this.#levelUp(player);
      const event = { timestamp: now, playerId: player.id, ...result };
      world.events.push(event);
      if (world.events.length > 100) world.events.shift();
      return { ok: true, event, player };
    });
  }

  advanceNpcBehavior(now = Date.now()) {
    return this.store.update((world) => {
      for (const player of Object.values(world.players)) this.#replenish(player, now);
      this.#ensureEconomy(world, now);
      const actions = Object.values(world.npcs).map((npc) => runNpcBehavior(npc, world, now)).filter(Boolean);
      world.events.push(...actions.map((action) => ({ timestamp: now, ...action })));
      if (world.events.length > 100) world.events.splice(0, world.events.length - 100);
      world.updatedAt = now;
      return actions;
    });
  }

  #replenish(player, now) {
    const resources = [
      ["energy", "energyUpdatedAt", RESOURCE_REGEN.maxEnergy, RESOURCE_REGEN.energy, RESOURCE_REGEN.energyIntervalMs],
      ["nerve", "nerveUpdatedAt", RESOURCE_REGEN.maxNerve, RESOURCE_REGEN.nerve, RESOURCE_REGEN.nerveIntervalMs],
    ];
    for (const [resource, timestampKey, cap, amount, interval] of resources) {
      if (player[resource] >= cap) {
        player[resource] = cap;
        player[timestampKey] = now;
        continue;
      }
      const elapsed = Math.max(0, now - player[timestampKey]);
      const periods = Math.floor(elapsed / interval);
      if (!periods) continue;
      player[resource] = Math.min(cap, player[resource] + periods * amount);
      player[timestampKey] += periods * interval;
      if (player[resource] >= cap) player[timestampKey] = now;
    }
  }

  #levelUp(player) {
    while (player.xp >= player.level * 100) {
      player.xp -= player.level * 100;
      player.level += 1;
      player.stats.influence += 1;
      player.health = 100;
    }
  }
}
