// Plans are enforced on the server. The browser shows the same table, but a
// limit only counts if the API refuses the request that would break it.

export const PLANS = {
  free: {
    id: 'free',
    name: 'Starter',
    priceInr: 0,
    contracts: 5,
    seats: 2,
    calendarFeed: false,
    auditExport: false,
    blurb: 'For a founder checking their own contracts.'
  },
  team: {
    id: 'team',
    name: 'Team',
    priceInr: 1999,
    contracts: 150,
    seats: 10,
    calendarFeed: true,
    auditExport: true,
    blurb: 'For a finance or ops lead who owns every vendor contract.'
  },
  business: {
    id: 'business',
    name: 'Business',
    priceInr: 7999,
    contracts: 2000,
    seats: 50,
    calendarFeed: true,
    auditExport: true,
    blurb: 'For firms with several departments signing contracts.'
  }
};

// Roles are ordered: each one can do everything the one before it can.
export const ROLES = ['viewer', 'member', 'admin', 'owner'];

export const CAN = {
  read: 'viewer',
  work: 'member',        // update obligations, review findings
  manage: 'admin',       // add or delete contracts, invite people
  own: 'owner'           // billing, roles of admins, erase the workspace
};

export function allowed(role, action) {
  return ROLES.indexOf(role) >= ROLES.indexOf(CAN[action]);
}

export function planOf(ws) {
  return PLANS[ws.plan] || PLANS.free;
}
