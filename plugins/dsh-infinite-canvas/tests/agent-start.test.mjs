import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_START_TIMEOUT_MS, DEFAULT_STOP_TIMEOUT_MS, probeHealth, resolveStartTimeout, stopChild, waitForReady } from "../src/agent-start.mjs";

/** 假子进程：stdout/stderr 是真流，exit/kill 由测试驱动。 */
function fakeChild({ exitCode = null } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = exitCode;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => {
        child.killed = true;
        if (child.exitCode === null) {
            child.exitCode = 1;
            child.emit("exit", 1);
        }
        return true;
    };
    return child;
}

test("就绪横幅出现后 resolve（横幅可跨多个数据块）", async () => {
    const child = fakeChild();
    const ready = waitForReady(child, { startTimeoutMs: 5000 });
    child.stdout.write("Infinite Canvas Agent\n");
    child.stdout.write("Local URL: http://127.0.0.1:59857\n");
    await ready;
    assert.equal(child.killed, false, "就绪后不应杀掉子进程");
});

test("等不到就绪横幅时必须落定并报错，而不是永久挂住（回归：这条曾经永远 pending）", async () => {
    const child = fakeChild();
    const ready = waitForReady(child, { startTimeoutMs: 30 });
    child.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:59857\n");
    await assert.rejects(ready, (error) => {
        assert.match(error.message, /启动超时/);
        assert.match(error.message, /EADDRINUSE/, "错误信息要带上子进程输出，否则没法诊断");
        return true;
    });
    assert.equal(child.killed, true, "超时的子进程要被杀掉");
});

test("子进程提前退出时报错并保留它的输出", async () => {
    const child = fakeChild();
    const ready = waitForReady(child, { startTimeoutMs: 5000 });
    child.stderr.write("端口被占用，启动中止");
    child.exitCode = 1;
    child.emit("exit", 1);
    await assert.rejects(ready, (error) => {
        assert.match(error.message, /启动失败/);
        assert.match(error.message, /端口被占用/);
        return true;
    });
});

test("spawn 自身失败时把原始错误抛出去", async () => {
    const child = fakeChild();
    const ready = waitForReady(child, { startTimeoutMs: 5000 });
    const failure = new Error("spawn ENOENT");
    child.emit("error", failure);
    await assert.rejects(ready, (error) => error === failure);
});

test("stopChild 会收掉还活着的子进程，已退出的直接跳过", async () => {
    const live = fakeChild();
    await stopChild(live, { stopTimeoutMs: 1000 });
    assert.equal(live.killed, true);

    const finished = fakeChild({ exitCode: 0 });
    await stopChild(finished, { stopTimeoutMs: 1000 });
    assert.equal(finished.killed, false);

    await stopChild(undefined);
});

test("probeHealth 依 ok 字段判定，并且带上探测超时", async () => {
    const seen = [];
    const healthy = await probeHealth("http://127.0.0.1:59857", {
        timeoutMs: 20,
        fetchImpl: async (url, options) => {
            seen.push({ url, signal: options.signal });
            return { ok: true, json: async () => ({ ok: true }) };
        },
    });
    assert.equal(healthy, true);
    assert.equal(seen[0].url, "http://127.0.0.1:59857/health");
    assert.ok(seen[0].signal instanceof AbortSignal, "探测必须带超时信号");
    assert.equal(seen[0].signal.aborted, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(seen[0].signal.aborted, true, "探测超时后信号要被中止");

    assert.equal(await probeHealth("http://127.0.0.1:1", { fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false }) }) }), false);
    assert.equal(await probeHealth("http://127.0.0.1:1", { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), false);
});

test("横幅没拿到、但健康探测通过时同样算就绪（避免把可用状态误判成启动失败）", async () => {
    const child = fakeChild();
    let calls = 0;
    const ready = waitForReady(child, {
        startTimeoutMs: 5000,
        probeIntervalMs: 10,
        probe: async () => {
            calls += 1;
            return calls >= 2;
        },
    });
    await ready;
    assert.ok(calls >= 2, "应通过健康探测判定就绪");
    assert.equal(child.killed, false);
});

test("探测本身抛错不会把等待打挂，最终仍按超时落定", async () => {
    const child = fakeChild();
    await assert.rejects(
        waitForReady(child, {
            startTimeoutMs: 40,
            probeIntervalMs: 5,
            probe: async () => {
                throw new Error("probe down");
            },
        }),
        /启动超时/,
    );
});

test("落定之后停止轮询探测", async () => {
    const child = fakeChild();
    let calls = 0;
    await assert.rejects(
        waitForReady(child, {
            startTimeoutMs: 30,
            probeIntervalMs: 5,
            probe: async () => {
                calls += 1;
                return false;
            },
        }),
        /启动超时/,
    );
    const seen = calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls, seen, "超时落定后不应继续探测");
});

test("启动等待上限支持环境变量覆盖，非法值回落默认", () => {
    assert.equal(resolveStartTimeout({}), DEFAULT_START_TIMEOUT_MS);
    assert.equal(resolveStartTimeout({ WHALEDRAW_AGENT_START_TIMEOUT_MS: "5000" }), 5000);
    assert.equal(resolveStartTimeout({ WHALEDRAW_AGENT_START_TIMEOUT_MS: "abc" }), DEFAULT_START_TIMEOUT_MS);
    assert.equal(resolveStartTimeout({ WHALEDRAW_AGENT_START_TIMEOUT_MS: "0" }), DEFAULT_START_TIMEOUT_MS);
    assert.equal(resolveStartTimeout({ WHALEDRAW_AGENT_START_TIMEOUT_MS: "-1" }), DEFAULT_START_TIMEOUT_MS);
});

test("超时默认值未被静默改动", () => {
    assert.equal(DEFAULT_START_TIMEOUT_MS, 20_000);
    assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 5_000);
    assert.equal(DEFAULT_STOP_TIMEOUT_MS, 3_000);
});
