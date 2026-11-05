// Debug: what does Conversation.watch deliver during one faux turn?
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { framesOf } from "../../src/frames";

const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage([fauxText("streamed answer")])]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
const conversation = await harness.conversation(root.id as never, context);
const watch = await conversation!.watch(context, { min: 50, max: 100 });
console.log("initial entries", watch.value.entries.length, "docs", Object.keys(watch.value.docs));
let previous = watch.value;
watch.start(async (call) => {
  if (call.kind !== "value") {
    console.log("call kind", call.kind);
    return;
  }
  console.log("value call: ops", JSON.stringify(call.ops).slice(0, 300));
  try {
    const frames = framesOf(previous, call.value, call.ops);
    previous = call.value;
    console.log("frames", JSON.stringify(frames.map((f) => f.type)));
  } catch (error) {
    console.log("framesOf threw", error);
  }
});
await (await root.submit({ type: "input", content: "stream me" }, context)).wait(context);
await new Promise((resolve) => setTimeout(resolve, 300));
await watch.stop();
await harness.close(context);
process.exit(0);
