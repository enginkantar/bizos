// Scope browser-local submissions to this copy of the site, including a Pages subpath.
const prefix = `bizos.demo-inbox:${new URL('../', import.meta.url).pathname}:`;

export function submitDemoMessage(envelope, storage = globalThis.localStorage) {
  // Separate keys avoid losing simultaneous submissions from two widget tabs.
  storage.setItem(prefix + envelope.message_id, JSON.stringify(envelope));
}

export function readDemoMessages(storage = globalThis.localStorage) {
  const messages = [];
  if (!storage) return messages;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const message = JSON.parse(storage.getItem(key));
      if (typeof message?.message_id === 'string' && typeof message.content?.text === 'string'
        && typeof message.reply_to === 'string') messages.push(message);
    } catch { /* A damaged browser record must not disable the rest of the demo inbox. */ }
  }
  return messages;
}
