import { createRegistry, Counter } from '@winkey/metrics';

export const chatRegistry = createRegistry('chat-svc');

export const chatMessagesSentCounter = new Counter({
  name: 'chat_messages_sent_total',
  help: 'Total number of Megolm messages sent in conversations',
  registers: [chatRegistry],
});

export const chatToDeviceSentCounter = new Counter({
  name: 'chat_to_device_sent_total',
  help: 'Total number of to-device messages routed',
  registers: [chatRegistry],
});

export const chatConversationsCreatedCounter = new Counter({
  name: 'chat_conversations_created_total',
  help: 'Total number of conversations created by kind',
  labelNames: ['kind'],
  registers: [chatRegistry],
});

export const chatPurgeDeletedCounter = new Counter({
  name: 'chat_to_device_purged_total',
  help: 'Total number of expired to-device messages purged',
  registers: [chatRegistry],
});
