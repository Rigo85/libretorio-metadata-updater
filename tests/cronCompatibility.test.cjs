const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {schedule, createTask, getTasks, validate} = require('node-cron');

afterEach(async () => {
  for (const task of getTasks().values()) await task.destroy();
});

test('Lima schedule does not execute at startup and uses the configured timezone', () => {
  let runs = 0;
  assert.equal(validate('0 3 * * *'), true);
  const task = schedule('0 3 * * *', () => { runs++; }, {timezone: 'America/Lima'});
  assert.equal(runs, 0);
  assert.equal(task.getNextRun().getUTCHours(), 8);
});

test('task lifecycle preserves a single registration', async () => {
  const task = createTask('* * * * *', () => {});
  assert.equal(task.getStatus(), 'stopped');
  await task.start();
  await task.start();
  assert.equal(getTasks().size, 1);
  await task.stop();
  assert.equal(task.getStatus(), 'stopped');
});
