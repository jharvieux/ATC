import { getNodeRuntimeError } from "./scripts/check-node-runtime.mjs";

const error = getNodeRuntimeError(process.version, process.execPath);
if (error) throw new Error(error);

export const hooks = {};
