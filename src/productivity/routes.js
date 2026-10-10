const express = require('express');
const db = require('../db');
const { calculateStreak } = require('./streaks');
const { calculateGoalProgress, calculateProjectProgress } = require('./progress');
const { parseReminder } = require('./reminderParser');
const { logger } = require('../logging/logger');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to use Productivity features.' });
}
function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'This feature isn\u2019t configured on this server yet.' });
  next();
}
router.use(requireAuth, notReadyIfNoDb);

// ── Calendar ─────────────────────────────────────────────────
router.get('/calendar', async (req, res) => {
  const events = await db.listEvents(req.dbUser.id, { from: req.query.from, to: req.query.to });
  res.json({ events });
});
router.post('/calendar', async (req, res) => {
  const { title, description, location, startTime, endTime } = req.body;
  if (!title || !startTime || isNaN(Date.parse(startTime))) return res.status(400).json({ error: 'title and a valid startTime are required' });
  const event = await db.createEvent(req.dbUser.id, { title, description, location, startTime, endTime });
  res.json({ event });
});
router.delete('/calendar/:id', async (req, res) => {
  const deleted = await db.deleteEvent(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Event not found' });
  res.json({ deleted: true });
});

// ── Notes ────────────────────────────────────────────────────
router.get('/notes', async (req, res) => res.json({ notes: await db.listNotes(req.dbUser.id) }));
router.post('/notes', async (req, res) => {
  const { title, content, tags } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  res.json({ note: await db.createNote(req.dbUser.id, { title, content, tags }) });
});
router.get('/notes/:id', async (req, res) => {
  const note = await db.getNote(parseInt(req.params.id, 10), req.dbUser.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json({ note });
});
router.patch('/notes/:id', async (req, res) => {
  const note = await db.updateNote(parseInt(req.params.id, 10), req.dbUser.id, req.body);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json({ note });
});
router.delete('/notes/:id', async (req, res) => {
  const deleted = await db.deleteNote(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Note not found' });
  res.json({ deleted: true });
});

// ── Projects & Tasks ─────────────────────────────────────────
router.get('/projects', async (req, res) => {
  const projects = await db.listProjects(req.dbUser.id);
  const withProgress = await Promise.all(projects.map(async p => {
    const tasks = await db.listTasks(req.dbUser.id, { projectId: p.id });
    return { ...p, progress: calculateProjectProgress(tasks) };
  }));
  res.json({ projects: withProgress });
});
router.post('/projects', async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  res.json({ project: await db.createProject(req.dbUser.id, { name, description }) });
});
router.delete('/projects/:id', async (req, res) => {
  const deleted = await db.deleteProject(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Project not found' });
  res.json({ deleted: true });
});

router.get('/tasks', async (req, res) => {
  const projectId = req.query.projectId !== undefined ? parseInt(req.query.projectId, 10) : undefined;
  const completed = req.query.completed !== undefined ? req.query.completed === 'true' : undefined;
  res.json({ tasks: await db.listTasks(req.dbUser.id, { projectId, completed }) });
});
router.post('/tasks', async (req, res) => {
  const { projectId, title, description, priority, dueDate } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
  res.json({ task: await db.createTask(req.dbUser.id, { projectId, title, description, priority, dueDate }) });
});
router.patch('/tasks/:id', async (req, res) => {
  const task = await db.updateTask(parseInt(req.params.id, 10), req.dbUser.id, req.body);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
});
router.delete('/tasks/:id', async (req, res) => {
  const deleted = await db.deleteTask(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  res.json({ deleted: true });
});

// ── Goals ────────────────────────────────────────────────────
router.get('/goals', async (req, res) => {
  const goals = await db.listGoals(req.dbUser.id);
  const withProgress = goals.map(g => ({ ...g, progress: calculateGoalProgress(Number(g.current_value), Number(g.target_value)) }));
  res.json({ goals: withProgress });
});
router.post('/goals', async (req, res) => {
  const { name, targetValue, currentValue, targetDate } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  res.json({ goal: await db.createGoal(req.dbUser.id, { name, targetValue, currentValue, targetDate }) });
});
router.patch('/goals/:id', async (req, res) => {
  const goal = await db.updateGoal(parseInt(req.params.id, 10), req.dbUser.id, req.body);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  res.json({ goal: { ...goal, progress: calculateGoalProgress(Number(goal.current_value), Number(goal.target_value)) } });
});
router.delete('/goals/:id', async (req, res) => {
  const deleted = await db.deleteGoal(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Goal not found' });
  res.json({ deleted: true });
});

// ── Habits ───────────────────────────────────────────────────
router.get('/habits', async (req, res) => {
  const habits = await db.listHabits(req.dbUser.id);
  const withStreaks = await Promise.all(habits.map(async h => {
    const logs = await db.getHabitLogs(h.id, req.dbUser.id);
    return { ...h, streak: calculateStreak(logs) };
  }));
  res.json({ habits: withStreaks });
});
router.post('/habits', async (req, res) => {
  const { name, frequency } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (frequency && !['daily', 'weekly'].includes(frequency)) return res.status(400).json({ error: 'frequency must be daily or weekly' });
  res.json({ habit: await db.createHabit(req.dbUser.id, { name, frequency }) });
});
router.delete('/habits/:id', async (req, res) => {
  const deleted = await db.deleteHabit(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Habit not found' });
  res.json({ deleted: true });
});
router.post('/habits/:id/check-in', async (req, res) => {
  const habitId = parseInt(req.params.id, 10);
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  if (isNaN(Date.parse(date))) return res.status(400).json({ error: 'invalid date' });
  await db.logHabitCompletion(habitId, req.dbUser.id, date);
  const logs = await db.getHabitLogs(habitId, req.dbUser.id);
  res.json({ streak: calculateStreak(logs) });
});

// ── AI Reminders ─────────────────────────────────────────────
// See reminderParser.js: parses + stores, does NOT deliver notifications.
router.post('/reminders', async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { naturalLanguageInput, title, dueAt, recurrence } = req.body;
    let reminderData;
    if (naturalLanguageInput) {
      reminderData = await parseReminder(naturalLanguageInput, req.app.locals.getAIReply, reqController.signal);
    } else {
      if (!title || !dueAt || isNaN(Date.parse(dueAt))) return res.status(400).json({ error: 'Provide either naturalLanguageInput, or title + a valid dueAt' });
      reminderData = { title, dueAt: new Date(dueAt).toISOString(), recurrence: recurrence || 'none' };
    }
    const reminder = await db.createReminder(req.dbUser.id, reminderData);
    res.json({
      reminder,
      note: 'Reminder saved. This app does not yet send notifications at the due time (no background worker exists) \u2014 check /api/productivity/reminders to see what\u2019s due.'
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.get('/reminders', async (req, res) => {
  res.json({ reminders: await db.listReminders(req.dbUser.id, { includeDismissed: req.query.includeDismissed === 'true' }) });
});
router.post('/reminders/:id/dismiss', async (req, res) => {
  const reminder = await db.dismissReminder(parseInt(req.params.id, 10), req.dbUser.id);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
  res.json({ reminder });
});

module.exports = { router };
