import { decodeNativeOperation, type NativeOperation, type SourceDomainDocument } from "@gitfoundry/contracts";

import sourceDomainJson from "../../../docs/source/handoff/contracts/domain.schema.json" with { type: "json" };
import operationsJson from "../../../docs/source/handoff/contracts/operations.json" with { type: "json" };

export const sourceDomain = sourceDomainJson as SourceDomainDocument;
export const nativeOperations: readonly NativeOperation[] = operationsJson.operations.map((operation) => decodeNativeOperation(operation));
export const nativeOperationCount = nativeOperations.length;
