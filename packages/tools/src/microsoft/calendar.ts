// Outlook calendar through Microsoft Graph, as in Ringkeeper's adapters/vendors/microsoft.py.
// calendar_read reads; calendar_write adds, changes, answers, cancels and deletes.
import { ToolError } from "../types.js";
import { s, type Schema } from "../google/schema.js";
import { htmlToText } from "../google/text.js";
import type { MicrosoftAccessKey } from "./access.js";
import { MOST_PEOPLE, ODATA, op, PEOPLE, peopleIn, TEXT_BODY, tidy, type Json } from "./graph.js";

const READS: MicrosoftAccessKey[] = ["calendar_read", "calendar_write"];
const EVENT_ID = { event_id: "The event's id, from list_events_between." };
const LIST_FIELDS = "id,subject,start,end,location,organizer,attendees,isAllDay,isOnlineMeeting,onlineMeeting,showAs,isCancelled,bodyPreview,webLink";

const WHEN: Schema = {
  type: "object",
  description: '{"dateTime": "2026-11-20T10:00:00", "timeZone": "Eastern Standard Time" or "America/New_York" or "UTC"}',
  properties: { dateTime: s.str({ minLength: 10, maxLength: 40 }), timeZone: s.str({ minLength: 1, maxLength: 100 }) },
  required: ["dateTime", "timeZone"],
};
const PLACE: Schema = { type: "object", description: '{"displayName": "Room 4"}', properties: { displayName: s.str({ maxLength: 500 }) } };
const ATTENDEE: Schema = {
  type: "object",
  description: '{"emailAddress": {"address": "anna@acme.example", "name": "Anna"}, "type": "required", "optional" or "resource"}',
  properties: { ...((PEOPLE.items as Schema).properties ?? {}), type: s.oneOf(["required", "optional", "resource"]) },
  required: ["emailAddress"],
};
const EDIT: Record<string, Schema> = {
  subject: s.str({ maxLength: 500 }),
  body: TEXT_BODY,
  start: WHEN,
  end: WHEN,
  location: PLACE,
  attendees: s.list(ATTENDEE, { maxItems: MOST_PEOPLE, description: "Each gets an invitation, or is told of a change." }),
  isAllDay: s.bool(),
  showAs: s.oneOf(["free", "tentative", "busy", "oof", "workingElsewhere"]),
  sensitivity: s.oneOf(["normal", "personal", "private", "confidential"]),
  categories: s.list(s.str({ maxLength: 255 }), { maxItems: 25 }),
  reminderMinutesBeforeStart: s.int({ minimum: 0, maximum: 40_320 }),
};
const EVENT: Record<string, Schema> = {
  ...EDIT,
  locations: s.list(PLACE, { maxItems: 20 }),
  isOnlineMeeting: s.bool({ description: "Add a Teams meeting (work or school accounts)." }),
  onlineMeetingProvider: s.oneOf(["teamsForBusiness", "skypeForBusiness", "skypeForConsumer"]),
  recurrence: { type: "object", description: 'Graph\'s patternedRecurrence: {"pattern": {"type": "weekly", "interval": 1, "daysOfWeek": ["monday"]}, "range": {"type": "endDate", "startDate": "2026-11-23", "endDate": "2026-12-21"}}' },
};
const ANSWER: Record<string, Schema> = {
  comment: s.str({ maxLength: 10_000 }),
  sendResponse: s.bool({ default: true, description: "Tell the organizer." }),
};

function notMany(body: Json): void {
  const total = peopleIn(body, ["attendees"]);
  if (total > MOST_PEOPLE) throw new ToolError(`That would invite ${total} people at once. Ringkeeper Connect invites at most ${MOST_PEOPLE} to one event.`);
}

/** An event as an agent reads it: its description as text rather than HTML. */
function readable(event: Json): Json {
  const out = tidy(event) as Json;
  const body = out.body as Json | undefined;
  if (body && String(body.contentType ?? "").toLowerCase() === "html") out.body = { contentType: "text", content: htmlToText(String(body.content ?? "")) };
  return out;
}

export const calendarTools = [
  op({
    name: "list_calendars",
    description: "This account's calendars, with their ids.",
    needs: READS,
    method: "GET",
    path: "/me/calendars",
    query: ODATA,
    pages: true,
  }),
  op({
    name: "list_events_between",
    description:
      "Events between two moments, repeats included, earliest first: subject, start, end, location, organizer, attendees, online meeting and Outlook link. Times are UTC unless time_zone is given.",
    needs: READS,
    method: "GET",
    path: "/me/calendarView",
    query: {
      startDateTime: s.str({ minLength: 10, maxLength: 40, description: "From, e.g. 2026-11-20T00:00:00Z." }),
      endDateTime: s.str({ minLength: 10, maxLength: 40, description: "Until, e.g. 2026-11-27T00:00:00Z." }),
      ...ODATA,
    },
    queryNames: { startDateTime: "startDateTime", endDateTime: "endDateTime" },
    local: { time_zone: s.str({ minLength: 1, maxLength: 100, description: "Show times in this time zone, e.g. Eastern Standard Time or America/New_York." }) },
    required: ["startDateTime", "endDateTime"],
    pages: true,
    prepare: (params) => ({ $select: LIST_FIELDS, $orderby: "start/dateTime", $top: 50, ...params }),
  }),
  op({
    name: "get_event",
    description: "Read one event, with its description as text.",
    needs: READS,
    method: "GET",
    path: "/me/events/{event_id}",
    ids: EVENT_ID,
    what: "that event",
    query: { select: ODATA.select },
    local: { time_zone: s.str({ minLength: 1, maxLength: 100, description: "Show times in this time zone." }) },
    after: (answer) => readable(answer),
  }),
  op({
    name: "create_event",
    description: `Add an event. Attendees (at most ${MOST_PEOPLE}) get an invitation.`,
    needs: ["calendar_write"],
    method: "POST",
    path: "/me/events",
    body: EVENT,
    required: ["subject", "start", "end"],
    check: notMany,
    after: (answer) => ({ id: answer.id, subject: answer.subject, start: answer.start, end: answer.end, link: answer.webLink, online: answer.onlineMeeting?.joinUrl ?? null }),
  }),
  op({
    name: "update_event",
    description: "Change an event: only the fields given change. Attendees are told.",
    needs: ["calendar_write"],
    method: "PATCH",
    path: "/me/events/{event_id}",
    ids: EVENT_ID,
    what: "that event",
    body: EDIT,
    check: notMany,
    after: (answer) => ({ id: answer.id, subject: answer.subject, start: answer.start, end: answer.end, link: answer.webLink }),
  }),
  op({
    name: "accept_event",
    description: "Accept an invitation.",
    needs: ["calendar_write"],
    method: "POST",
    path: "/me/events/{event_id}/accept",
    ids: EVENT_ID,
    what: "that event",
    body: ANSWER,
  }),
  op({
    name: "decline_event",
    description: "Decline an invitation.",
    needs: ["calendar_write"],
    method: "POST",
    path: "/me/events/{event_id}/decline",
    ids: EVENT_ID,
    what: "that event",
    body: ANSWER,
  }),
  op({
    name: "cancel_event",
    description: "Cancel a meeting this account organizes, and tell everyone on it.",
    needs: ["calendar_write"],
    method: "POST",
    path: "/me/events/{event_id}/cancel",
    ids: EVENT_ID,
    what: "that event",
    body: { comment: s.str({ maxLength: 10_000, description: "Said to the attendees." }) },
  }),
  op({
    name: "delete_event",
    description: "Delete an event from this calendar. For a meeting this account organizes, cancel_event tells the attendees.",
    needs: ["calendar_write"],
    method: "DELETE",
    path: "/me/events/{event_id}",
    ids: EVENT_ID,
    what: "that event",
  }),
];
