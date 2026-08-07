// Keep these imports static and ordered. Firefox discovers wakeable event-page
// listeners during module startup, so delaying the main background module until
// the runtime frame loads would make alarms/messages unreliable after suspend.
import "@src/workers/firefox-runtime-host";
import "@src/workers/background";
