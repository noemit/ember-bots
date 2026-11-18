import {
  createContextRule,
  deleteContextRule,
  listContextRules,
  parseContextRuleInput,
  parseContextRulePatch,
  updateContextRule,
} from "../../context";
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  nextOccurrence,
  parseScheduledTaskInput,
  parseScheduledTaskPatch,
  runScheduledTaskNow,
  updateScheduledTask,
  type ScheduledTask,
} from "../../scheduler";
import {
  allConversations,
  badRequest,
  brief,
  decodeSegment,
  json,
  LARGE_BODY_MAX_BYTES,
  noRoute,
  notFound,
  readBody,
  routeMethods,
  serverContext,
} from "../http";
import { queueSessionOf, scheduledTaskRefusal } from "../summary";
import type { RouteContext } from "../types";

const context = serverContext;

const withWireNextRunAt = (
  task: ScheduledTask,
  now = Date.now(),
  hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): ScheduledTask & { nextRunAt?: number } => {
  const nextRunAt = task.enabled ? nextOccurrence(task.schedule, now, hostTimezone) : undefined;
  return nextRunAt !== undefined ? { ...task, nextRunAt } : task;
};

export const handleTaskRoutes = async (ctx: RouteContext): Promise<Response | null> => {
  const { request, path, runtime } = ctx;
  const { storage, harness } = runtime.deps;

  if (request.method === "GET" && path === "/queue") {
    const sessions = [];
    for (const record of await allConversations(storage)) {
      const session = await queueSessionOf(harness, record.id);
      if (session.items.length === 0) continue;
      sessions.push(session);
    }
    return json({ revision: Date.now(), sessions });
  }

  if (path === "/context-rules") {
    if (request.method === "GET") {
      return json({ rules: (await listContextRules(harness, context)).rules });
    }
    if (request.method === "POST") {
      const input = parseContextRuleInput(await readBody(request, LARGE_BODY_MAX_BYTES));
      if (!input) return badRequest("invalid context rule");
      return json(await createContextRule(harness, input, context), 201);
    }
    return noRoute(request.method, path, routeMethods(path));
  }

  const contextRuleMatch = /^\/context-rules\/([^/]+)$/.exec(path);
  if (contextRuleMatch) {
    const id = decodeSegment(contextRuleMatch[1]);
    if (request.method === "PATCH") {
      const updated = await updateContextRule(
        harness,
        id,
        parseContextRulePatch(await readBody(request, LARGE_BODY_MAX_BYTES)),
        context
      );
      if (!updated) return notFound(`there is no context rule "${brief(id, 100)}"`);
      return json(updated);
    }
    if (request.method === "DELETE") {
      return (await deleteContextRule(harness, id, context))
        ? json({ ok: true })
        : notFound(`there is no context rule "${brief(id, 100)}"`);
    }
    return noRoute(request.method, path, routeMethods(path));
  }

  if (path === "/scheduled-tasks") {
    if (request.method === "GET") {
      const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = Date.now();
      const state = await listScheduledTasks(harness, context);
      return json({
        tasks: state.tasks.map((task) => withWireNextRunAt(task, now, hostTimezone)),
        timezone: hostTimezone,
      });
    }
    if (request.method === "POST") {
      const body = await readBody(request);
      const input = parseScheduledTaskInput(body);
      if (!input) return badRequest(scheduledTaskRefusal(body));
      return json(withWireNextRunAt(await createScheduledTask(harness, input, context)), 201);
    }
    return noRoute(request.method, path, routeMethods(path));
  }

  const scheduledMatch = /^\/scheduled-tasks\/([^/]+)(?:\/(run))?$/.exec(path);
  if (scheduledMatch) {
    const id = decodeSegment(scheduledMatch[1]);
    const action = scheduledMatch[2];
    if (action === "run" && request.method === "POST") {
      const outcome = await runScheduledTaskNow(harness, id, context);
      if (!outcome) return notFound(`there is no scheduled task "${brief(id, 100)}"`);
      if (outcome.refused) return json(outcome, 409);
      return json(outcome, outcome.status === "ok" ? 200 : 502);
    }
    if (!action && request.method === "PATCH") {
      const updated = await updateScheduledTask(harness, id, parseScheduledTaskPatch(await readBody(request)), context);
      if (!updated) return notFound(`there is no scheduled task "${brief(id, 100)}"`);
      return json(withWireNextRunAt(updated));
    }
    if (!action && request.method === "DELETE") {
      return (await deleteScheduledTask(harness, id, context))
        ? json({ ok: true })
        : notFound(`there is no scheduled task "${brief(id, 100)}"`);
    }
    return noRoute(request.method, path, routeMethods(path));
  }

  return null;
};
