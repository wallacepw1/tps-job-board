// TPS On call calendar writer, for the Swap / Holiday / Day off buttons in the TPS Assistant /phone pop-up.
// Paste this whole file into a new Google Apps Script project (script.google.com) while signed in as the
// Google account that owns the "On call" calendar. Setup steps: docs/phone-settings.md.
// It only adds or removes events on the On call calendar, and only removes events the phone tool added.

const CALENDAR_ID = '1786572778cebba3673499013d509e6366d4cc8a8f32219a5a8c815d3fdd0973@group.calendar.google.com';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const key = PropertiesService.getScriptProperties().getProperty('KEY');
    if (!key || body.key !== key) return reply({ ok: false, error: 'wrong key' });
    const cal = CalendarApp.getCalendarById(CALENDAR_ID);
    if (!cal) return reply({ ok: false, error: 'On call calendar not found for this Google account' });
    if (body.action === 'create') {
      const options = { description: String(body.description || '') };
      let ev;
      if (body.allDay) ev = cal.createAllDayEvent(String(body.title), day(body.startDate), day(body.endDate), options);
      else ev = cal.createEvent(String(body.title), new Date(body.start), new Date(body.end), options);
      return reply({ ok: true, id: ev.getId() });
    }
    if (body.action === 'delete') {
      const ev = cal.getEventById(String(body.id));
      if (!ev) return reply({ ok: true, gone: true });
      if (String(ev.getDescription()).indexOf('TPS Assistant') < 0) return reply({ ok: false, error: 'that event was not added by the phone tool' });
      ev.deleteEvent();
      return reply({ ok: true });
    }
    return reply({ ok: false, error: 'unknown action' });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

// 'YYYY-MM-DD' as a date in the script's time zone (set it to Pacific in Project Settings).
function day(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function reply(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// Run this once from the editor (Run > testSetup) to grant calendar access and check the calendar is found.
function testSetup() { Logger.log(CalendarApp.getCalendarById(CALENDAR_ID).getName()); }
