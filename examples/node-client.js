// Server-side only. Persist eventId with your business event and reuse it on retry.
async function requestSurvey({
  eventId,
  sourceApp,
  eventType,
  recipient,
  metadata = {},
}) {
  const base = new URL(process.env.CLICKSURVEY_URL);
  if (
    base.protocol !== "https:" &&
    base.hostname !== "localhost" &&
    base.hostname !== "127.0.0.1"
  )
    throw Error("Use HTTPS for ClickSurvey");
  const response = await fetch(new URL("/api/events", base), {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CLICKSURVEY_API_KEY}`,
    },
    body: JSON.stringify({
      eventId,
      sourceApp,
      eventType,
      recipient,
      metadata,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.success)
    throw Object.assign(Error(result.error || "Survey request failed"), {
      status: response.status,
    });
  if (!result.inviteCreated)
    throw Object.assign(
      Error("No matching active survey rule; event was recorded"),
      { status: 409, eventId },
    );
  return result;
}
module.exports = { requestSurvey };
