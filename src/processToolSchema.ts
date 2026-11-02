import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const attention = StringEnum(["turn", "context", "ignore"] as const);
const mode = StringEnum(["literal", "regex"] as const);
const stream = StringEnum(["stdout", "stderr", "both"] as const);
const watchProperties = {
  mode: Type.Optional(mode), stream: Type.Optional(stream), repeat: Type.Optional(Type.Boolean()), on: Type.Optional(attention),
};
const watch = Type.Object({ pattern: Type.String({ maxLength: 500 }), ...watchProperties });
/** The compatible process action schema, with the child ownership option added. */
export const processToolParameters = Type.Object({
  action: StringEnum(["start", "list", "stop", "output", "write", "update", "clear"] as const),
  name: Type.Optional(Type.String({ description: "Specific process name. Required for start." })),
  command: Type.Optional(Type.String({ description: "Shell command. Required for start." })),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to this agent's working directory." })),
  id: Type.Optional(Type.String({ description: "Opaque ID from start or list, not a name." })),
  keepAfterChild: Type.Optional(Type.Boolean({ description: "Default false; ignored outside a child. A child starting something for its parent sets true and says so in its report. Update can change it." })),
  notify: Type.Optional(Type.Object({
    onSuccess: Type.Optional(attention), onFailure: Type.Optional(attention), onKilled: Type.Optional(attention),
    logMatches: Type.Optional(Type.Array(watch, { maxItems: 20 })),
  })),
  limit: Type.Optional(Type.Number()),
  sortBy: Type.Optional(StringEnum(["startTime_desc", "startTime_asc", "name_asc", "name_desc", "status_asc"] as const)),
  statuses: Type.Optional(Type.Array(StringEnum(["all", "running", "finished", "failed", "terminating", "terminate_timeout", "killed"] as const))),
  stream: Type.Optional(stream),
  tailLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  pattern: Type.Optional(Type.String({ maxLength: 500 })), mode: Type.Optional(mode),
  input: Type.Optional(Type.String()), end: Type.Optional(Type.Boolean()),
  watches: Type.Optional(Type.Object({
    mode: StringEnum(["append", "replace", "remove", "clear"] as const),
    items: Type.Optional(Type.Array(Type.Object({ index: Type.Optional(Type.Integer({ minimum: 0 })), pattern: Type.Optional(Type.String({ maxLength: 500 })), ...watchProperties }), { maxItems: 20 })),
  })),
});
export type ProcessToolArguments = Static<typeof processToolParameters>;

export class ProcessToolInputError extends Error {}
