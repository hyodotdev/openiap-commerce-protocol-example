import Ajv from "ajv/dist/2020.js";
import { bundleSchema, HTTP_BINDING } from "openiap-commerce-protocol";

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(bundleSchema);
const validators = new Map();

export function validate(pointer, value) {
  if (!validators.has(pointer)) {
    validators.set(pointer, ajv.compile({ $ref: bundleSchema.$id + pointer }));
  }
  return validators.get(pointer)(value);
}

export function operation(name) {
  return HTTP_BINDING.operations.find((entry) => entry.name === name);
}

export function protocolError(code) {
  return Response.json(
    { error: { code, message: code.replaceAll("_", " ").toLowerCase() } },
    { status: HTTP_BINDING.errorStatus[code] },
  );
}
