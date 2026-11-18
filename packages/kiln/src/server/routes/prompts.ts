import type { ConversationId } from "@earendil-works/pi-durable";
import {
  pendingApprovals,
  previewPermission,
  replyApproval,
  replySimilarApproval,
  type ApprovalDecision,
} from "../../approvals";
import { QuestionsDoc, replyQuestion } from "../../ask";
import {
  answerQuestion,
  appendQuestionContext,
  authorizeQuestionResume,
  listQuestions,
  reconcileQuestions,
  resumeQuestions,
  withdrawQuestion,
} from "../../questions";
import {
  allConversations,
  badRequest,
  brief,
  decodeSegment,
  idOf,
  json,
  notFound,
  PAGE_BYTE_BUDGET,
  readBody,
  serverContext,
} from "../http";
import type { RouteContext } from "../types";

const context = serverContext;

export const handlePromptRoutes = async (ctx: RouteContext): Promise<Response | null> => {
  const { request, url, path, runtime } = ctx;
  const { storage, harness } = runtime.deps;

  if (path === "/approvals" && request.method === "GET") {
    const ids = (await allConversations(storage)).map((record) => record.id);
    return json({ approvals: await pendingApprovals(harness, ids, context) });
  }

  const approvalPreview = /^\/approvals\/([^/]+)\/([^/]+)\/preview$/.exec(path);
  if (approvalPreview && request.method === "POST") {
    const id = idOf<ConversationId>(decodeSegment(approvalPreview[1]));
    if (!id) return badRequest("invalid conversation id");
    const body = await readBody(request);
    if (body.command !== undefined && typeof body.command !== "string") {
      return badRequest("Kiln needs command text. Restore the original command and try again.");
    }
    return json(await previewPermission(harness, id, decodeSegment(approvalPreview[2]), body.command, context));
  }

  const approvalReply = /^\/approvals\/([^/]+)\/([^/]+)\/reply$/.exec(path);
  if (approvalReply && request.method === "POST") {
    const body = await readBody(request);
    const decision = body.decision;
    if (decision !== "once" && decision !== "always" && decision !== "reject" && decision !== "similar") {
      return badRequest("decision must be once, always, similar or reject");
    }
    const conversationId = idOf<ConversationId>(decodeSegment(approvalReply[1]));
    if (!conversationId) return badRequest("invalid conversation id");
    const key = decodeSegment(approvalReply[2]);
    let found: boolean;
    if (decision === "similar") {
      if (body.command !== undefined && typeof body.command !== "string") {
        return badRequest("Kiln needs command text. Restore the original command and try again.");
      }
      try {
        found = await replySimilarApproval(harness, conversationId, key, body.command, context);
      } catch (error) {
        return badRequest(
          error instanceof Error ? error.message : "Kiln could not validate this rule. Use Allow once or refresh the approval."
        );
      }
    } else {
      found = await replyApproval(harness, conversationId, key, decision as ApprovalDecision, context);
    }
    return found
      ? json({ ok: true })
      : notFound(`conversation ${conversationId} has no approval "${brief(key, 100)}" waiting`);
  }

  if (path === "/questions" && request.method === "GET") {
    const ids = (await allConversations(storage)).map((record) => record.id);
    const rawLimit = url.searchParams.get("limit");
    const rawCursor = url.searchParams.get("cursor");
    const paginated = rawLimit !== null || rawCursor !== null;
    const limit = rawLimit === null ? 200 : Number(rawLimit);
    const cursor = Number(rawCursor ?? "0");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(cursor) || cursor < 0) {
      return badRequest("Use a Questions page size from 1–500 and the next cursor returned by Kiln.");
    }
    const questions = await listQuestions(harness, ids, context);
    if (!paginated) return json({ questions });
    const page = questions.slice(cursor, cursor + limit);
    while (page.length > 1 && Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTE_BUDGET) page.pop();
    const next = cursor + page.length;
    return json({ questions: page, ...(next < questions.length ? { next: String(next) } : {}) });
  }

  const questionReply = /^\/questions\/([^/]+)\/([^/]+)\/(reply|withdraw|resume|context)$/.exec(path);
  if (questionReply && request.method === "POST") {
    const body = await readBody(request);
    const answer = body.answer;
    const conversationId = idOf<ConversationId>(decodeSegment(questionReply[1]));
    if (!conversationId) return badRequest("invalid conversation id");
    const key = decodeSegment(questionReply[2]);
    await reconcileQuestions(harness, conversationId, context);
    const existing = (await harness.snapshot(QuestionsDoc, conversationId, context))?.items[key];
    if (!existing) return notFound("Kiln no longer has this question. Refresh Questions to review the current inbox.");
    if (existing.mode === "async") {
      const revision = body.revision;
      const requestId = body.requestId;
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        typeof requestId !== "string" ||
        !requestId.trim() ||
        requestId.length > 200
      ) {
        return badRequest("Review the question's revision and provide a requestId (up to 200 characters).");
      }
      const action = questionReply[3];
      if ((action === "reply" || action === "context") && (typeof answer !== "string" || !answer.trim() || answer.length > 32000)) {
        return badRequest("Write an answer of 1–32,000 characters, or use Withdraw to close the question.");
      }
      const result =
        action === "withdraw"
          ? await withdrawQuestion(harness, conversationId, key, revision, requestId, context)
          : action === "context"
            ? await appendQuestionContext(harness, conversationId, key, answer as string, revision, requestId, context)
            : action === "resume"
              ? await authorizeQuestionResume(harness, conversationId, key, revision, requestId, context)
              : await answerQuestion(harness, conversationId, key, answer as string, revision, requestId, context);
      if (!result.ok) {
        return result.error === "missing"
          ? notFound("Kiln no longer has this question. Refresh Questions to review the current inbox.")
          : json(
              {
                error:
                  result.error === "limit"
                    ? "This question already has 100 additional messages. Open its source chat to continue."
                    : "This question changed. Refresh Questions before trying again.",
              },
              409
            );
      }
      await resumeQuestions(harness, conversationId, context);
      return json(result);
    }
    if (questionReply[3] !== "reply") {
      return badRequest("This is a legacy waiting question. Answer or dismiss it using Reply.");
    }
    if (answer !== null && typeof answer !== "string") return badRequest("answer must be a string or null");
    const found = await replyQuestion(harness, conversationId, key, answer, context);
    return found
      ? json({ ok: true })
      : notFound(`conversation ${conversationId} has no question "${brief(key, 100)}" waiting`);
  }

  return null;
};
