import { randomUUID } from "node:crypto";

const COMPANY_FEE = 500;
const SHARE_PRICE = 25;
const ASSETS = {
  kiosk: { name: "Street kiosk", cost: 250, incomePerMinute: 4 },
  workshop: { name: "Machine shop", cost: 750, incomePerMinute: 14 },
  data_vault: { name: "Data vault", cost: 1_500, incomePerMinute: 35 },
};

const fail = (error, status = 400) => ({ error, status });
const manager = (company, playerId) => {
  const member = company?.members.find((entry) => entry.playerId === playerId);
  return member && ["ceo", "cfo"].includes(member.role) ? member : null;
};

export function createCompany(world, playerId, rawName) {
  const player = world.players[playerId];
  const name = String(rawName ?? "").trim();
  if (!player) return fail("Player not found", 404);
  if (name.length < 3 || name.length > 32) return fail("Company name must be 3–32 characters");
  if (!/^[\p{L}\p{N} .'-]+$/u.test(name)) return fail("Company name contains unsupported characters");
  if (player.credits < COMPANY_FEE) return fail(`Founding costs ${COMPANY_FEE} credits`);
  if (Object.values(world.companies).some((company) => company.name.toLowerCase() === name.toLowerCase())) return fail("That company name is already taken");

  const id = randomUUID();
  player.credits -= COMPANY_FEE;
  world.companies[id] = {
    id, name, foundedAt: Date.now(), territory: player.territory, credits: COMPANY_FEE,
    totalShares: 1_000, treasuryShares: 400,
    members: [{ playerId, principalType: "player", role: "ceo", shares: 600, wagePerMinute: 0 }],
    assets: [], reputation: 0,
  };
  return { ok: true, company: world.companies[id] };
}

export function performCompanyAction(world, playerId, payload) {
  const company = world.companies[payload.companyId];
  if (!company) return fail("Company not found", 404);
  const actor = company.members.find((entry) => entry.playerId === playerId);
  if (!actor) return fail("You are not a member of this company", 403);
  const isManager = ["ceo", "cfo"].includes(actor.role);

  if (payload.type === "deposit") {
    const amount = Math.floor(Number(payload.amount));
    if (!Number.isFinite(amount) || amount < 1) return fail("Enter a positive whole number of credits");
    const player = world.players[playerId];
    if (player.credits < amount) return fail("Not enough personal credits");
    player.credits -= amount;
    company.credits += amount;
    return { ok: true, company };
  }

  if (payload.type === "buy_shares") {
    const amount = Math.floor(Number(payload.amount));
    if (!Number.isFinite(amount) || amount < 1) return fail("Enter a positive number of shares");
    if (company.treasuryShares < amount) return fail("The company has fewer shares available than that");
    const cost = amount * SHARE_PRICE;
    const player = world.players[playerId];
    if (player.credits < cost) return fail(`Need ${cost} personal credits`);
    player.credits -= cost;
    company.credits += cost;
    company.treasuryShares -= amount;
    actor.shares += amount;
    return { ok: true, company, cost };
  }

  if (!isManager) return fail("Only company managers can do that", 403);

  if (payload.type === "buy_asset") {
    const asset = ASSETS[payload.assetType];
    if (!asset) return fail("Unknown asset type");
    if (company.credits < asset.cost) return fail(`The company needs ${asset.cost} credits`);
    company.credits -= asset.cost;
    company.assets.push({ id: randomUUID(), type: payload.assetType, name: asset.name, incomePerMinute: asset.incomePerMinute, purchasedAt: Date.now() });
    return { ok: true, company, asset };
  }

  if (payload.type === "invite_member") {
    const invitee = world.players[payload.targetPlayerId];
    if (!invitee) return fail("Player not found", 404);
    if (company.members.some((entry) => entry.playerId === invitee.id)) return fail("That player already belongs to this company");
    company.members.push({ playerId: invitee.id, principalType: "player", role: "employee", shares: 0, wagePerMinute: 0 });
    return { ok: true, company };
  }

  if (payload.type === "set_wage") {
    const member = company.members.find((entry) => entry.playerId === payload.targetPlayerId);
    const wage = Math.floor(Number(payload.amount));
    if (!member) return fail("That player is not a company member");
    if (!Number.isFinite(wage) || wage < 0 || wage > 100) return fail("Wage must be between 0 and 100 credits per minute");
    member.wagePerMinute = wage;
    return { ok: true, company };
  }

  if (payload.type === "promote") {
    const member = company.members.find((entry) => entry.playerId === payload.targetPlayerId);
    if (!member || member.role === "ceo") return fail("That member cannot be promoted");
    if (payload.role !== "cfo" && payload.role !== "employee") return fail("Supported roles are CFO and employee");
    member.role = payload.role;
    return { ok: true, company };
  }

  if (payload.type === "offer_contract") {
    const counterparty = world.companies[payload.counterpartyCompanyId];
    const amount = Math.floor(Number(payload.amount));
    if (!counterparty || counterparty.id === company.id) return fail("Choose another existing company");
    if (!Number.isFinite(amount) || amount < 1 || amount > 100_000) return fail("Contract payment must be 1–100,000 credits per minute");
    const contract = { id: randomUUID(), fromCompanyId: company.id, toCompanyId: counterparty.id, amountPerMinute: amount, status: "offered", offeredAt: Date.now(), signedAt: null, nextPaymentAt: null };
    world.contracts.push(contract);
    return { ok: true, contract };
  }

  if (payload.type === "sign_contract") {
    const contract = world.contracts.find((entry) => entry.id === payload.contractId && entry.toCompanyId === company.id && entry.status === "offered");
    if (!contract) return fail("No matching contract offer");
    contract.status = "active";
    contract.signedAt = Date.now();
    contract.nextPaymentAt = contract.signedAt + 60_000;
    return { ok: true, contract };
  }

  if (payload.type === "cancel_contract") {
    const contract = world.contracts.find((entry) => entry.id === payload.contractId && [entry.fromCompanyId, entry.toCompanyId].includes(company.id) && entry.status === "active");
    if (!contract) return fail("No active matching contract");
    contract.status = "cancelled";
    return { ok: true, contract };
  }

  return fail("Unknown company action");
}

export function advanceCompanyEconomy(world, now = Date.now()) {
  const elapsedMinutes = Math.floor((now - world.companyUpdatedAt) / 60_000);
  if (elapsedMinutes < 1) return [];
  const settledMinutes = Math.min(60, elapsedMinutes);
  const firstSettledMinute = world.companyUpdatedAt + (elapsedMinutes - settledMinutes) * 60_000;
  const transactions = [];

  for (let minute = 0; minute < settledMinutes; minute += 1) {
    const at = firstSettledMinute + (minute + 1) * 60_000;
    for (const company of Object.values(world.companies)) {
      const income = company.assets.reduce((sum, asset) => sum + asset.incomePerMinute, 0);
      company.credits += income;
      if (income) transactions.push({ type: "asset_income", companyId: company.id, amount: income, timestamp: at });
      for (const member of company.members) {
        if (member.wagePerMinute <= 0 || company.credits < member.wagePerMinute) continue;
        company.credits -= member.wagePerMinute;
        const recipient = world.players[member.playerId];
        if (recipient) recipient.credits += member.wagePerMinute;
        else if (world.npcs[member.playerId]) world.npcs[member.playerId].wealth += member.wagePerMinute;
        transactions.push({ type: "wage", companyId: company.id, playerId: member.playerId, amount: member.wagePerMinute, timestamp: at });
      }
    }
    for (const contract of world.contracts) {
      if (contract.status !== "active" || at < contract.nextPaymentAt) continue;
      const payer = world.companies[contract.fromCompanyId];
      const recipient = world.companies[contract.toCompanyId];
      if (payer && recipient && payer.credits >= contract.amountPerMinute) {
        payer.credits -= contract.amountPerMinute;
        recipient.credits += contract.amountPerMinute;
        transactions.push({ type: "contract_payment", contractId: contract.id, amount: contract.amountPerMinute, timestamp: at });
      }
      contract.nextPaymentAt += 60_000;
    }
  }
  world.companyUpdatedAt += elapsedMinutes * 60_000;
  if (transactions.length) {
    world.companyTransactions.push(...transactions);
    if (world.companyTransactions.length > 100) world.companyTransactions.splice(0, world.companyTransactions.length - 100);
  }
  return transactions;
}

export function visibleCompanies(world, playerId) {
  return Object.values(world.companies).map((company) => ({
    ...company,
    members: company.members.map((member) => ({
      playerId: member.playerId,
      name: world.players[member.playerId]?.name ?? world.npcs[member.playerId]?.name ?? "Former member",
      role: member.role,
      shares: member.shares,
      wagePerMinute: member.wagePerMinute,
    })),
    contracts: world.contracts.filter((contract) => [contract.fromCompanyId, contract.toCompanyId].includes(company.id)),
    canManage: Boolean(manager(company, playerId)),
  }));
}

export const COMPANY_RULES = { foundingCost: COMPANY_FEE, sharePrice: SHARE_PRICE, assets: ASSETS };

export function foundNpcCompany(world, npc) {
  if (npc.companyId || npc.wealth < COMPANY_FEE) return null;
  const id = randomUUID();
  npc.wealth -= COMPANY_FEE;
  world.companies[id] = {
    id, name: `${npc.name.split(" ")[0]} Holdings`, foundedAt: Date.now(), territory: npc.territory,
    credits: COMPANY_FEE, totalShares: 1_000, treasuryShares: 400,
    members: [{ playerId: npc.id, principalType: "npc", role: "ceo", shares: 600, wagePerMinute: 0 }],
    assets: [], reputation: npc.reputation,
  };
  npc.companyId = id;
  return world.companies[id];
}

export function buyNpcAsset(world, npc) {
  const company = npc.companyId ? world.companies[npc.companyId] : null;
  if (!company || company.members[0]?.playerId !== npc.id) return null;
  const affordable = Object.entries(ASSETS)
    .filter(([type, asset]) => company.credits >= asset.cost && !company.assets.some((owned) => owned.type === type))
    .sort(([, a], [, b]) => b.incomePerMinute / b.cost - a.incomePerMinute / a.cost)[0];
  if (!affordable) return null;
  const [type, asset] = affordable;
  company.credits -= asset.cost;
  company.assets.push({ id: randomUUID(), type, name: asset.name, incomePerMinute: asset.incomePerMinute, purchasedAt: Date.now() });
  return asset;
}
