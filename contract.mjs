import Ajv from 'ajv/dist/2020.js';
import bundle from '@hyodotdev/openiap-commerce-protocol/generated/schemas/commerce-protocol.bundle.schema.json' with { type: 'json' };
import manifest from '@hyodotdev/openiap-commerce-protocol/generated/bindings/http-binding.json' with { type: 'json' };

export { manifest };
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(bundle, 'commerce');
export function valid(pointer, value) {
  return ajv.validate(`commerce${pointer}`, value);
}
export function failure(code) {
  const body = { error: { code, message: code.toLowerCase().replaceAll('_', ' ') } };
  return Response.json(body, { status: manifest.errorStatus[code] ?? 500 });
}
export function result(operation, body) {
  if (!valid(operation.result, body)) throw new Error('Invalid operation response');
  return Response.json(body, { status: operation.successStatus });
}

export class ProtocolFault extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const knownEvents = bundle.$defs.CommerceEvent.properties.eventType.examples;
