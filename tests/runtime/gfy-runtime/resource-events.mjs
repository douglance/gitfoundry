import fs from "node:fs";

async function openEvents(apiBase, tenant, token, { repository, cursor, queryCursor } = {}) {
  const controller = new AbortController();
  const params = new URLSearchParams(repository ? { repository_id: repository } : {});
  if (queryCursor) params.set("cursor", queryCursor);
  const response = await fetch(apiBase + "/api/v1/tenants/" + tenant + "/events?" + params, {
    headers: { authorization: "Bearer " + token, ...(cursor ? { "last-event-id": cursor } : {}) },
    signal: controller.signal
  });
  if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    controller.abort();
    throw new Error("Event stream did not open: " + response.status);
  }
  const reader = response.body.getReader();
  const state = { events: [], live: false, heartbeats: 0, closed: false, error: null };
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame === ": live") state.live = true;
          if (frame === ": heartbeat") state.heartbeats += 1;
          const fields = frame.split("\n");
          const data = fields.find(line => line.startsWith("data:"))?.slice(5).trim();
          if (data) state.events.push({
            event: fields.find(line => line.startsWith("event:"))?.slice(6).trim(),
            id: fields.find(line => line.startsWith("id:"))?.slice(3).trim(),
            data: JSON.parse(data)
          });
          notify();
        }
      }
    } catch (error) { if (!controller.signal.aborted) state.error = error; }
    finally { state.closed = true; notify(); }
  })();
  const wait = (predicate, label, timeout = 20000) => new Promise((resolve, reject) => {
    const finish = () => {
      const value = predicate(state);
      if (value) { clearTimeout(timer); listeners.delete(finish); resolve(value); }
      else if (state.closed) { clearTimeout(timer); listeners.delete(finish); reject(state.error || new Error(label + ": event stream closed before expected evidence")); }
    };
    const timer = setTimeout(() => { listeners.delete(finish); reject(new Error(label + ": event stream timed out")); }, timeout);
    listeners.add(finish);
    finish();
  });
  return { state, wait, async cancelBody() { await reader.cancel(); await reading; }, async close() { controller.abort(); await reader.cancel().catch(() => {}); await reading; } };
}

export async function exerciseResourceEventStream({ apiBase, seedBase, credentialFiles, versionCommit, otherRepositoryId, withTenantClient, callNative, assertRuntime }) {
  const token = fs.readFileSync(credentialFiles.tenantA, "utf8").trim();
  const streams = [];
  const open = async options => { const stream = await openEvents(apiBase, "tenant-a", token, options); streams.push(stream); await stream.wait(state => state.live, "stream replay completes"); return stream; };
  const requestDenied = async (tenant, authorization) => {
    const response = await fetch(apiBase + "/api/v1/tenants/" + tenant + "/events", { headers: authorization ? { authorization } : {}, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return response.status;
  };
  try {
    const statuses = await Promise.all([requestDenied("tenant-a"), requestDenied("tenant-a", "Bearer invalid"), requestDenied("tenant-b", "Bearer " + token)]);
    assertRuntime("event stream enforces missing, invalid, and foreign-tenant credentials", JSON.stringify(statuses) === JSON.stringify([401, 401, 403]), { statuses });

    const history = await open({ repository: "repo-tenant-a" });
    const changes = history.state.events.filter(event => event.event === "change");
    const storedResponse = await fetch(seedBase + "/event-rows?tenant=tenant-a&repository=repo-tenant-a");
    const stored = (await storedResponse.json()).rows;
    assertRuntime("event stream replays exact independently persisted D1 rows in cursor order", storedResponse.status === 200 && stored.length > 2 && JSON.stringify(changes.map(event => [event.id, event.data.source_event_id, event.data.authoritative_revision])) === JSON.stringify(stored.map(row => [row.cursor, row.source_event_id, row.authoritative_revision])), { events: changes.length });
    assertRuntime("event stream publication names the independently verified canonical version and resource", changes.some(event => event.data.kind === "head_updated" && event.data.authoritative_revision === versionCommit && event.data.resource_uris.includes("gfy://tenant/tenant-a/repositories/repo-tenant-a/forge/head")) && changes.every(event => event.data.tenant_id === "tenant-a" && event.data.repository_id === "repo-tenant-a"), { version: versionCommit });
    const cursor = changes.at(-2).id;
    const expectedReplay = changes.slice(-1);
    await history.close();
    const replay = await open({ repository: "repo-tenant-a", cursor });
    assertRuntime("Last-Event-ID reconnect replays only events after the requested durable cursor", JSON.stringify(replay.state.events) === JSON.stringify(expectedReplay), { cursor, replayed: replay.state.events.length });
    await replay.close();

    const queryReplay = await open({ repository: "repo-tenant-a", queryCursor: cursor });
    assertRuntime("query cursor reconnect replays the exact durable suffix", JSON.stringify(queryReplay.state.events) === JSON.stringify(expectedReplay), { cursor });
    await queryReplay.close();
    const precedence = await open({ repository: "repo-tenant-a", cursor, queryCursor: "malformed-query-cursor" });
    assertRuntime("Last-Event-ID header takes precedence over the query cursor", JSON.stringify(precedence.state.events) === JSON.stringify(expectedReplay), {});
    await precedence.close();
    for (const unsafeCursor of ["gfy_-1", "gfy_9007199254740992"]) {
      const unsafe = await open({ repository: "repo-tenant-a", cursor: unsafeCursor });
      assertRuntime("unsafe numeric event cursor resets without replay: " + unsafeCursor, unsafe.state.events.length === 1 && unsafe.state.events[0].event === "reset" && unsafe.state.events[0].data.reason === "invalid_cursor", {});
      await unsafe.close();
    }
    const invalidCursor = await open({ repository: "repo-tenant-a", cursor: "malformed-cursor" });
    assertRuntime("invalid event cursor returns a reset without replaying history", invalidCursor.state.events.length === 1 && invalidCursor.state.events[0].event === "reset" && invalidCursor.state.events[0].data.reason === "invalid_cursor", {});
    await invalidCursor.close();

    const closing = await open({ repository: "repo-tenant-a" });
    const survivor = await open({ repository: "repo-tenant-a" });
    const filtered = await open({ repository: otherRepositoryId });
    const filteredBaseline = filtered.state.events.length;
    assertRuntime("second same-tenant repository has independently populated event history", filteredBaseline > 0 && filtered.state.events.every(event => event.data.repository_id === otherRepositoryId), { repository: otherRepositoryId, events: filteredBaseline });
    const baselineEvents = survivor.state.events.length;
    const bodyCancelled = await fetch(apiBase + "/api/v1/tenants/tenant-a/events?repository_id=repo-tenant-a", { headers: { authorization: "Bearer " + token, "x-gfy-test-cancel-event-response": "1" }, signal: AbortSignal.timeout(5000) });
    assertRuntime("actual API response body cancellation executes before HTTP transport", bodyCancelled.status === 200 && (await bodyCancelled.json()).cancelled_actual_response_body === true, {});
    await closing.cancelBody();
    const fork = await withTenantClient(async client => callNative(client, "gfy_forge_fork", { tenant_id: "tenant-a", repository_id: "repo-tenant-a", operation_id: "resource-event-live-fork", parent_version: versionCommit }, true));
    const forkVersion = fork.version ?? fork;
    const independentlyStoredPeerEvent = (await (await fetch(seedBase + "/event-rows?tenant=tenant-a&repository=repo-tenant-a")).json()).rows;
    assertRuntime("peer API worker persists its native Git fork event in shared D1 before live delivery", independentlyStoredPeerEvent.some(row => row.authoritative_revision === forkVersion.version_commit), { version: forkVersion.version_commit });
    const delivered = await survivor.wait(state => state.events.slice(baselineEvents).find(event => event.event === "change" && event.data.authoritative_revision === forkVersion.version_commit), "peer stream receives new fork after another subscriber closes");
    assertRuntime("closing one event subscriber preserves live delivery to other subscribers", delivered.data.operation_id === "forge.fork" && delivered.data.kind === "version_created" && !survivor.state.closed, { version: forkVersion.version_commit });
    const heartbeatAfterFork = filtered.state.heartbeats;
    await filtered.wait(state => state.heartbeats >= heartbeatAfterFork + 2, "filtered stream completes a later polling cycle after the live fork", 40000);
    assertRuntime("repository-filtered stream excludes events from another populated repository", filtered.state.live && !filtered.state.closed && filtered.state.events.length === filteredBaseline, {});
    const rowsAfter = (await (await fetch(seedBase + "/event-rows?tenant=tenant-a&repository=repo-tenant-a")).json()).rows;
    assertRuntime("live event persists independently in D1 with its exact cursor and fork revision", rowsAfter.some(row => row.cursor === delivered.id && row.authoritative_revision === forkVersion.version_commit && row.source_event_id === delivered.data.source_event_id), { cursor: delivered.id });

    const deliveredCount = survivor.state.events.length;
    const repeated = await withTenantClient(async client => callNative(client, "gfy_forge_fork", { tenant_id: "tenant-a", repository_id: "repo-tenant-a", operation_id: "resource-event-live-fork", parent_version: versionCommit }, true));
    assertRuntime("idempotent fork replay returns the original live event revision", (repeated.version ?? repeated).version_commit === forkVersion.version_commit, {});
    const heartbeatAfterReplay = survivor.state.heartbeats;
    await survivor.wait(state => state.heartbeats > heartbeatAfterReplay, "heartbeat follows idempotent fork replay");
    const rowsAfterReplay = (await (await fetch(seedBase + "/event-rows?tenant=tenant-a&repository=repo-tenant-a")).json()).rows;
    assertRuntime("idempotent fork replay adds no durable or live duplicate event", JSON.stringify(rowsAfterReplay) === JSON.stringify(rowsAfter) && survivor.state.events.length === deliveredCount, { events: rowsAfterReplay.length });

    const replayLimit = 256;
    const additionalForks = replayLimit - rowsAfterReplay.length;
    assertRuntime("native event history can reach the independently specified replay boundary", additionalForks > 0 && additionalForks < replayLimit, { additionalForks });
    await withTenantClient(async client => {
      for (let index = 0; index < additionalForks; index += 1) {
        await callNative(client, "gfy_forge_fork", { tenant_id: "tenant-a", repository_id: "repo-tenant-a", operation_id: "resource-event-boundary-" + index, parent_version: versionCommit }, true);
      }
    });
    const atBoundary = (await (await fetch(seedBase + "/event-rows?tenant=tenant-a&repository=repo-tenant-a")).json()).rows;
    assertRuntime("real native fork operations persist exactly 256 replayable events", atBoundary.length === replayLimit && new Set(atBoundary.map(row => row.cursor)).size === replayLimit, { events: atBoundary.length });
    const completeReplay = await open({ repository: "repo-tenant-a" });
    assertRuntime("event replay includes the complete 256-event boundary in durable order", completeReplay.state.events.length === replayLimit && completeReplay.state.events.every(event => event.event === "change") && JSON.stringify(completeReplay.state.events.map(event => [event.id, event.data.authoritative_revision])) === JSON.stringify(atBoundary.map(row => [row.cursor, row.authoritative_revision])), {});
    await completeReplay.close();
    await withTenantClient(async client => callNative(client, "gfy_forge_fork", { tenant_id: "tenant-a", repository_id: "repo-tenant-a", operation_id: "resource-event-boundary-overflow", parent_version: versionCommit }, true));
    const beyondBoundary = (await (await fetch(seedBase + "/event-rows?tenant=tenant-a&repository=repo-tenant-a")).json()).rows;
    assertRuntime("overflow event is persisted through an actual native Git fork", beyondBoundary.length === replayLimit + 1, { events: beyondBoundary.length });
    const overflow = await open({ repository: "repo-tenant-a" });
    assertRuntime("257-event history returns replay_window_exceeded without partial history", overflow.state.events.length === 1 && overflow.state.events[0].event === "reset" && overflow.state.events[0].data.reason === "replay_window_exceeded", {});
    await overflow.close();
    const boundedReconnect = await open({ repository: "repo-tenant-a", cursor: beyondBoundary.at(-2).cursor });
    assertRuntime("cursor reconnect recovers the exact suffix after a replay-window reset", boundedReconnect.state.events.length === 1 && boundedReconnect.state.events[0].id === beyondBoundary.at(-1).cursor && boundedReconnect.state.events[0].data.authoritative_revision === beyondBoundary.at(-1).authoritative_revision, {});
    await boundedReconnect.close();
    const revocationReader = await open({ repository: "repo-tenant-a", cursor: beyondBoundary.at(-1).cursor });
    const revoked = await fetch(seedBase + "/deactivate-stream-principal", { method: "POST" });
    assertRuntime("stream principal revocation is persisted in the actual identity database", revoked.status === 200 && (await revoked.json()).changed === 1, {});
    const postRevocationFork = await withTenantClient(async client => callNative(client, "gfy_forge_fork", { tenant_id: "tenant-a", repository_id: "repo-tenant-a", operation_id: "resource-event-after-reader-revocation", parent_version: versionCommit }, true), true);
    const postRevocationVersion = (postRevocationFork.version ?? postRevocationFork).version_commit;
    const postRevocationRows = (await (await fetch(seedBase + "/event-rows?tenant=tenant-a&repository=repo-tenant-a")).json()).rows;
    assertRuntime("independent active writer persists a real event after reader revocation", postRevocationRows.some(row => row.authoritative_revision === postRevocationVersion), { version: postRevocationVersion });
    const firstAfterRevocation = await revocationReader.wait(state => state.events[0], "revoked reader receives authorization reset before new data", 30000);
    assertRuntime("revoked reader receives no event from the still-active native writer", firstAfterRevocation.event === "reset" && firstAfterRevocation.data.reason === "authorization_revoked" && !revocationReader.state.events.some(event => event.event === "change"), { received: firstAfterRevocation.event, revision: firstAfterRevocation.data.authoritative_revision });
    const reset = firstAfterRevocation;
    assertRuntime("admitted event stream reports authorization revocation", reset.data.reason === "authorization_revoked", {});
    await revocationReader.wait(state => state.closed, "revoked stream closes");
    return { persistedReplay: changes.length, liveDelivery: true, cursorReplay: true, invalidCursorReset: true, queryCursor: true, cursorPrecedence: true, replayBoundary: replayLimit, overflowReset: true, eventDeduplication: true, subscriberIsolation: true, revocation: true };
  } finally { await Promise.all(streams.map(stream => stream.close())); }
}
