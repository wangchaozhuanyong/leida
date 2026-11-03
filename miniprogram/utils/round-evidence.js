function announcementNeedsReview(action, resolution, eventId) {
  if (!resolution || resolution.kind !== action.kind || !(Date.parse(resolution.statementAt) > Date.parse(action.statementAt))) return false;
  // An independently identified round with an evidenced lifecycle cannot close this one.
  const actionId = action.actionId || action.id;
  const differentRound = eventId && resolution.eventId && (eventId !== resolution.eventId || (actionId && resolution.actionId && actionId !== resolution.actionId));
  return !(differentRound && resolution.announcedAt
    && Date.parse(resolution.announcedAt) < Date.parse(action.statementAt));
}
module.exports = {announcementNeedsReview};
