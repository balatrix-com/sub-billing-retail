const EventEmitter = require('events');

class EventService extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(10);
  }

  emit(eventName, data) {
    console.log(`[EventService] Emitting event: ${eventName}`, data);
    super.emit(eventName, data);
  }

  on(eventName, handler) {
    console.log(`[EventService] Registered listener for: ${eventName}`);
    return super.on(eventName, handler);
  }

  once(eventName, handler) {
    console.log(`[EventService] Registered one-time listener for: ${eventName}`);
    return super.once(eventName, handler);
  }
}

module.exports = new EventService();
