'use strict';

function mountMissionRoutes(app, missionEngine, { limiter = (req, res, next) => next(), maxBodyBytes = 512 * 1024 } = {}) {
  const P = '/api/victus/missions';
  const bodyLimit = (req, res, next) => {
    const len = Number(req.get('content-length') || 0);
    if (len > maxBodyBytes) return res.status(413).json({ error: 'Mission request too large', code: 'PAYLOAD_TOO_LARGE' });
    next();
  };
  const auth = (req, res, next) => req.dbUser?.id != null ? next() : res.status(401).json({ error: 'Sign in required' });
  const tenant = req => `user:${req.dbUser.id}`;
  const approval = req => req.body?.approved === true || String(req.get('x-victus-mission-approval') || '').toLowerCase() === 'true';
  const safe = fn => async (req, res) => {
    try { return res.json(await fn(req, res)); }
    catch (err) {
      const msg = String(err?.message || err);
      const status = /not found/i.test(msg) ? 404 : /required|invalid|unsupported|exceeds|limit|cycle|dependency|approval/i.test(msg) ? 400 : /capacity|conflict/i.test(msg) ? 409 : 500;
      return res.status(status).json({ error: msg });
    }
  };

  app.post(`${P}`, limiter, bodyLimit, auth, safe(async req => ({ mission: await missionEngine.createMission(req.body || {}, tenant(req)) })));
  app.get(`${P}`, limiter, auth, safe(async req => ({ missions: await missionEngine.listMissions(tenant(req), req.query || {}) })));
  app.get(`${P}/:id`, limiter, auth, safe(async req => {
    const mission = await missionEngine.getMission(tenant(req), req.params.id);
    if (!mission) throw new Error('mission not found');
    return { mission };
  }));
  app.post(`${P}/:id/start`, limiter, bodyLimit, auth, safe(async req => ({
    mission: await missionEngine.startMission(tenant(req), req.params.id, { humanApproval: approval(req) }),
  })));
  app.post(`${P}/:id/pause`, limiter, auth, safe(async req => ({ mission: await missionEngine.pauseMission(tenant(req), req.params.id) })));
  app.post(`${P}/:id/cancel`, limiter, auth, safe(async req => ({ mission: await missionEngine.cancelMission(tenant(req), req.params.id) })));
}

module.exports = { mountMissionRoutes };
