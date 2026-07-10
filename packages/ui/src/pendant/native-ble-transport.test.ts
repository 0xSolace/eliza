/**
 * NativeBlePendantTransport protocol plumbing, against a mocked BleClient.
 *
 * Verifies the transport drives the omi UUIDs correctly, windows notification
 * DataViews into Uint8Arrays, falls back to the Opus default when the codec
 * char is unreadable, tolerates a missing battery service, normalizes a
 * cancelled chooser, and cleans up on disconnect.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type BleClientLike,
  NativeBlePendantTransport,
} from "./native-ble-transport";
import {
  BATTERY_LEVEL_CHAR_UUID_128,
  OMI_AUDIO_CODEC_CHAR_UUID,
  OMI_AUDIO_DATA_CHAR_UUID,
  OMI_AUDIO_SERVICE_UUID,
  OMI_CODEC,
} from "./omi-protocol";
import { PendantUserCancelledError } from "./pendant-transport";

/** Build a DataView over the given bytes. */
function dv(bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface MockClientOptions {
  deviceName?: string;
  codec?: number | "throw";
  battery?: number | "throw";
  requestThrows?: unknown;
}

function makeMockClient(opts: MockClientOptions = {}): {
  client: BleClientLike;
  audioCallbacks: Array<(v: DataView) => void>;
  batteryCallbacks: Array<(v: DataView) => void>;
  disconnectCalls: string[];
  stopCalls: Array<{ service: string; char: string }>;
} {
  const audioCallbacks: Array<(v: DataView) => void> = [];
  const batteryCallbacks: Array<(v: DataView) => void> = [];
  const disconnectCalls: string[] = [];
  const stopCalls: Array<{ service: string; char: string }> = [];

  const client: BleClientLike = {
    initialize: vi.fn(async () => {}),
    requestDevice: vi.fn(async () => {
      if (opts.requestThrows !== undefined) throw opts.requestThrows;
      return { deviceId: "dev-1", name: opts.deviceName };
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async (id: string) => {
      disconnectCalls.push(id);
    }),
    read: vi.fn(async (_id, service, char) => {
      if (char === OMI_AUDIO_CODEC_CHAR_UUID) {
        if (opts.codec === "throw") throw new Error("codec unreadable");
        return dv([opts.codec ?? OMI_CODEC.OPUS_16K]);
      }
      if (char === BATTERY_LEVEL_CHAR_UUID_128) {
        if (opts.battery === "throw") throw new Error("no battery");
        return dv([opts.battery ?? 88]);
      }
      throw new Error(`unexpected read ${service}/${char}`);
    }),
    startNotifications: vi.fn(async (_id, _service, char, cb) => {
      if (char === OMI_AUDIO_DATA_CHAR_UUID) audioCallbacks.push(cb);
      else if (char === BATTERY_LEVEL_CHAR_UUID_128) batteryCallbacks.push(cb);
    }),
    stopNotifications: vi.fn(async (_id, service, char) => {
      stopCalls.push({ service, char });
    }),
  };

  return {
    client,
    audioCallbacks,
    batteryCallbacks,
    disconnectCalls,
    stopCalls,
  };
}

describe("NativeBlePendantTransport", () => {
  it("initializes with androidNeverForLocation and connects by audio service", async () => {
    const mock = makeMockClient({ deviceName: "Friend-ab12" });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });

    const res = await t.requestAndConnect();
    expect(res.deviceName).toBe("Friend-ab12");
    expect(mock.client.initialize).toHaveBeenCalledWith({
      androidNeverForLocation: true,
    });
    expect(mock.client.requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({ services: [OMI_AUDIO_SERVICE_UUID] }),
    );
    expect(mock.client.connect).toHaveBeenCalledWith(
      "dev-1",
      expect.any(Function),
    );
  });

  it("reads the codec id from the codec characteristic", async () => {
    const mock = makeMockClient({ codec: OMI_CODEC.OPUS_16K });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();
    expect(await t.readCodec()).toBe(OMI_CODEC.OPUS_16K);
  });

  it("falls back to the Opus default when the codec char is unreadable", async () => {
    const mock = makeMockClient({ codec: "throw" });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();
    expect(await t.readCodec()).toBe(OMI_CODEC.OPUS_16K);
  });

  it("delivers audio notifications windowed to their bytes", async () => {
    const mock = makeMockClient();
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();

    const received: Uint8Array[] = [];
    await t.startAudio((payload) => received.push(payload));
    expect(mock.audioCallbacks).toHaveLength(1);

    // Deliver a DataView that is a *window* into a larger buffer — the transport
    // must respect the offset/length, not read the whole buffer.
    const backing = new Uint8Array([0xff, 0xff, 0x00, 0x01, 0x02, 0x03]);
    const windowed = new DataView(backing.buffer, 2, 3); // bytes [0x00,0x01,0x02]
    mock.audioCallbacks[0](windowed);

    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([0x00, 0x01, 0x02]);
  });

  it("reads initial battery and streams updates", async () => {
    const mock = makeMockClient({ battery: 73 });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();

    const updates: number[] = [];
    const initial = await t.startBattery((p) => updates.push(p));
    expect(initial).toBe(73);
    expect(mock.batteryCallbacks).toHaveLength(1);

    mock.batteryCallbacks[0](dv([42]));
    expect(updates).toEqual([42]);
  });

  it("returns null battery when the service is absent (never throws)", async () => {
    const mock = makeMockClient({ battery: "throw" });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();
    await expect(t.startBattery(() => {})).resolves.toBeNull();
  });

  it("normalizes a cancelled chooser to PendantUserCancelledError", async () => {
    const mock = makeMockClient({
      requestThrows: new Error("User cancelled the request"),
    });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await expect(t.requestAndConnect()).rejects.toBeInstanceOf(
      PendantUserCancelledError,
    );
  });

  it("routes a remote disconnect to the registered handler", async () => {
    const mock = makeMockClient();
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    let disconnected = false;
    t.onDisconnected(() => {
      disconnected = true;
    });
    await t.requestAndConnect();
    // The connect callback (2nd arg) is the remote-disconnect hook.
    const onDisc = (mock.client.connect as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as (id: string) => void;
    onDisc("dev-1");
    expect(disconnected).toBe(true);
  });

  it("stops notifications and disconnects on teardown", async () => {
    const mock = makeMockClient({ battery: 90 });
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await t.requestAndConnect();
    await t.startAudio(() => {});
    await t.startBattery(() => {});

    await t.disconnect();

    expect(mock.disconnectCalls).toEqual(["dev-1"]);
    const stoppedChars = mock.stopCalls.map((c) => c.char);
    expect(stoppedChars).toContain(OMI_AUDIO_DATA_CHAR_UUID);
    expect(stoppedChars).toContain(BATTERY_LEVEL_CHAR_UUID_128);
  });

  it("does not stop or disconnect the physical link from a stale same-device transport", async () => {
    const mock = makeMockClient({ battery: 90 });
    const oldTransport = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    const newTransport = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });

    await oldTransport.requestAndConnect();
    await oldTransport.startAudio(() => {});
    await oldTransport.startBattery(() => {});
    await newTransport.requestAndConnect();

    await oldTransport.disconnect();

    expect(mock.disconnectCalls).toEqual([]);
    expect(mock.stopCalls).toEqual([]);
  });

  it("does not physically disconnect when a newer owner appears during awaited teardown", async () => {
    const firstStop = deferred<void>();
    const stopCalls: Array<{ deviceId: string; char: string }> = [];
    const client: BleClientLike = {
      initialize: vi.fn(async () => {}),
      requestDevice: vi
        .fn()
        .mockResolvedValueOnce({ deviceId: "old-device", name: "old pendant" })
        .mockResolvedValueOnce({ deviceId: "new-device", name: "new pendant" }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      read: vi.fn(async (_id, _service, char) =>
        char === BATTERY_LEVEL_CHAR_UUID_128
          ? dv([90])
          : dv([OMI_CODEC.OPUS_16K]),
      ),
      startNotifications: vi.fn(async () => {}),
      stopNotifications: vi.fn(async (deviceId, _service, char) => {
        stopCalls.push({ deviceId, char });
        if (stopCalls.length === 1) await firstStop.promise;
      }),
    };
    const oldTransport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });
    const newTransport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });

    await oldTransport.requestAndConnect();
    await oldTransport.startAudio(() => {});
    await oldTransport.startBattery(() => {});

    const oldDisconnect = oldTransport.disconnect();
    await flushMicrotasks();
    expect(stopCalls).toEqual([
      { deviceId: "old-device", char: OMI_AUDIO_DATA_CHAR_UUID },
    ]);

    await expect(newTransport.requestAndConnect()).resolves.toEqual({
      deviceName: "new pendant",
    });
    await newTransport.startAudio(() => {});
    await newTransport.startBattery(() => {});

    firstStop.resolve();
    await oldDisconnect;

    expect(stopCalls).toEqual([
      { deviceId: "old-device", char: OMI_AUDIO_DATA_CHAR_UUID },
    ]);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("disconnect is safe before connect (idempotent, no throw)", async () => {
    const mock = makeMockClient();
    const t = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    await expect(t.disconnect()).resolves.toBeUndefined();
  });

  it("does not connect an old chooser result after a newer transport owns the shared client", async () => {
    const oldChooser = deferred<{ deviceId: string; name?: string }>();
    const requestDevice = vi
      .fn()
      .mockImplementationOnce(() => oldChooser.promise)
      .mockResolvedValueOnce({ deviceId: "new-device", name: "new pendant" });
    const connect = vi.fn(async () => {});
    const client: BleClientLike = {
      initialize: vi.fn(async () => {}),
      requestDevice,
      connect,
      disconnect: vi.fn(async () => {}),
      read: vi.fn(async () => dv([OMI_CODEC.OPUS_16K])),
      startNotifications: vi.fn(async () => {}),
      stopNotifications: vi.fn(async () => {}),
    };
    const oldTransport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });
    const newTransport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });

    const oldAttempt = oldTransport.requestAndConnect();
    await flushMicrotasks();
    await oldTransport.disconnect();
    await expect(newTransport.requestAndConnect()).resolves.toEqual({
      deviceName: "new pendant",
    });

    oldChooser.resolve({ deviceId: "old-device", name: "old pendant" });
    await expect(oldAttempt).rejects.toThrow("superseded");

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("new-device", expect.any(Function));
    expect(connect).not.toHaveBeenCalledWith("old-device", expect.anything());
  });

  it("does not let a stale deferred client load supersede a newer connected owner", async () => {
    const oldLoad = deferred<BleClientLike>();
    const disconnectHandlers = new Map<string, (id: string) => void>();
    const client: BleClientLike = {
      initialize: vi.fn(async () => {}),
      requestDevice: vi.fn(async () => ({
        deviceId: "new-device",
        name: "new pendant",
      })),
      connect: vi.fn(
        async (deviceId: string, onDisconnect?: (id: string) => void) => {
          if (onDisconnect) disconnectHandlers.set(deviceId, onDisconnect);
        },
      ),
      disconnect: vi.fn(async () => {}),
      read: vi.fn(async () => dv([OMI_CODEC.OPUS_16K])),
      startNotifications: vi.fn(async () => {}),
      stopNotifications: vi.fn(async () => {}),
    };
    const oldTransport = new NativeBlePendantTransport({
      loadClient: () => oldLoad.promise,
    });
    const newTransport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });
    const oldDisconnected = vi.fn();
    const newDisconnected = vi.fn();
    oldTransport.onDisconnected(oldDisconnected);
    newTransport.onDisconnected(newDisconnected);

    const oldAttempt = oldTransport.requestAndConnect();
    await flushMicrotasks();
    await oldTransport.disconnect();
    await expect(newTransport.requestAndConnect()).resolves.toEqual({
      deviceName: "new pendant",
    });

    oldLoad.resolve(client);
    await expect(oldAttempt).rejects.toThrow("superseded");
    disconnectHandlers.get("new-device")?.("new-device");

    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.requestDevice).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledWith(
      "new-device",
      expect.anything(),
    );
    expect(oldDisconnected).not.toHaveBeenCalled();
    expect(newDisconnected).toHaveBeenCalledTimes(1);
  });

  it("lets the later concurrent requestAndConnect intent win on one transport", async () => {
    const firstLoad = deferred<BleClientLike>();
    const client = makeMockClient({ deviceName: "later pendant" }).client;
    const loadClient = vi
      .fn<() => Promise<BleClientLike>>()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce(client);
    const transport = new NativeBlePendantTransport({ loadClient });

    const firstAttempt = transport.requestAndConnect();
    await flushMicrotasks();
    const secondAttempt = transport.requestAndConnect();
    await expect(secondAttempt).resolves.toEqual({
      deviceName: "later pendant",
    });

    firstLoad.resolve(client);
    await expect(firstAttempt).rejects.toThrow("superseded");

    expect(loadClient).toHaveBeenCalledTimes(2);
    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.requestDevice).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("does not let an older different client overwrite a newer connected intent", async () => {
    const firstLoad = deferred<BleClientLike>();
    const oldClient = makeMockClient({ deviceName: "old pendant" }).client;
    const newDisconnected = vi.fn();
    let newDisconnectHandler: ((id: string) => void) | undefined;
    const newClient: BleClientLike = {
      ...makeMockClient({ deviceName: "new pendant" }).client,
      connect: vi.fn(
        async (_deviceId: string, onDisconnect?: (id: string) => void) => {
          newDisconnectHandler = onDisconnect;
        },
      ),
    };
    const loadClient = vi
      .fn<() => Promise<BleClientLike>>()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce(newClient);
    const transport = new NativeBlePendantTransport({ loadClient });
    transport.onDisconnected(newDisconnected);

    const firstAttempt = transport.requestAndConnect();
    await flushMicrotasks();
    const secondAttempt = transport.requestAndConnect();
    await expect(secondAttempt).resolves.toEqual({
      deviceName: "new pendant",
    });

    firstLoad.resolve(oldClient);
    await expect(firstAttempt).rejects.toThrow("superseded");
    newDisconnectHandler?.("dev-1");

    expect(newDisconnected).toHaveBeenCalledTimes(1);
    expect(oldClient.initialize).toHaveBeenCalledTimes(0);
    expect(oldClient.requestDevice).toHaveBeenCalledTimes(0);
    expect(oldClient.connect).toHaveBeenCalledTimes(0);
    expect(newClient.initialize).toHaveBeenCalledTimes(1);
    expect(newClient.requestDevice).toHaveBeenCalledTimes(1);
    expect(newClient.connect).toHaveBeenCalledTimes(1);
  });

  it("treats a stale deferred client load failure as superseded", async () => {
    const firstLoad = deferred<BleClientLike>();
    const client = makeMockClient({ deviceName: "later pendant" }).client;
    const loadClient = vi
      .fn<() => Promise<BleClientLike>>()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce(client);
    const transport = new NativeBlePendantTransport({ loadClient });

    const firstAttempt = transport.requestAndConnect();
    await flushMicrotasks();
    await expect(transport.requestAndConnect()).resolves.toEqual({
      deviceName: "later pendant",
    });

    firstLoad.reject(new Error("native plugin load failed"));
    await expect(firstAttempt).rejects.toThrow("superseded");
    await expect(firstAttempt).rejects.not.toBeInstanceOf(
      PendantUserCancelledError,
    );

    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.requestDevice).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("ignores old connect completion and disconnect callback after a newer transport owns the shared client", async () => {
    const oldConnect = deferred<void>();
    const disconnectHandlers = new Map<string, (id: string) => void>();
    const client: BleClientLike = {
      initialize: vi.fn(async () => {}),
      requestDevice: vi
        .fn()
        .mockResolvedValueOnce({ deviceId: "old-device", name: "old pendant" })
        .mockResolvedValueOnce({ deviceId: "new-device", name: "new pendant" }),
      connect: vi.fn(
        async (deviceId: string, onDisconnect?: (id: string) => void) => {
          if (onDisconnect) disconnectHandlers.set(deviceId, onDisconnect);
          if (deviceId === "old-device") await oldConnect.promise;
        },
      ),
      disconnect: vi.fn(async () => {}),
      read: vi.fn(async () => dv([OMI_CODEC.OPUS_16K])),
      startNotifications: vi.fn(async () => {}),
      stopNotifications: vi.fn(async () => {}),
    };
    const oldTransport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });
    const newTransport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });
    const oldDisconnected = vi.fn();
    const newDisconnected = vi.fn();
    oldTransport.onDisconnected(oldDisconnected);
    newTransport.onDisconnected(newDisconnected);

    const oldAttempt = oldTransport.requestAndConnect();
    await flushMicrotasks();
    await expect(newTransport.requestAndConnect()).resolves.toEqual({
      deviceName: "new pendant",
    });

    disconnectHandlers.get("old-device")?.("old-device");
    expect(oldDisconnected).not.toHaveBeenCalled();
    expect(newDisconnected).not.toHaveBeenCalled();

    oldConnect.resolve();
    await expect(oldAttempt).rejects.toThrow("superseded");
    expect(newTransport.canRetryAfterTimeout()).toBe(false);
    expect(oldTransport.canRetryAfterTimeout()).toBe(false);
  });

  it("ignores stale audio and battery callbacks captured by an old operation on the same transport", async () => {
    const mock = makeMockClient({ battery: 73 });
    const transport = new NativeBlePendantTransport({
      loadClient: async () => mock.client,
    });
    const audio: Uint8Array[] = [];
    const battery: number[] = [];

    await transport.requestAndConnect();
    await transport.startAudio((payload) => audio.push(payload));
    await transport.startBattery((percent) => battery.push(percent));
    const oldAudioCallback = mock.audioCallbacks[0];
    const oldBatteryCallback = mock.batteryCallbacks[0];

    await transport.requestAndConnect();

    oldAudioCallback?.(dv([1, 2, 3]));
    oldBatteryCallback?.(dv([44]));

    expect(audio).toEqual([]);
    expect(battery).toEqual([]);
  });

  it("rejects a stale startAudio completion when another operation starts on the same transport", async () => {
    const startAudio = deferred<void>();
    const client = makeMockClient().client;
    client.startNotifications = vi.fn(async () => {
      await startAudio.promise;
    });
    const transport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });

    await transport.requestAndConnect();
    const staleStart = transport.startAudio(() => {});
    await flushMicrotasks();
    await transport.requestAndConnect();

    startAudio.resolve();
    await expect(staleStart).rejects.toThrow("superseded");
  });

  it("rejects a stale readCodec completion when another operation starts on the same transport", async () => {
    const codecRead = deferred<DataView>();
    const client = makeMockClient().client;
    client.read = vi.fn(async (_id, _service, char) => {
      if (char === OMI_AUDIO_CODEC_CHAR_UUID) return codecRead.promise;
      return dv([88]);
    });
    const transport = new NativeBlePendantTransport({
      loadClient: async () => client,
    });

    await transport.requestAndConnect();
    const staleRead = transport.readCodec();
    await flushMicrotasks();
    await transport.requestAndConnect();

    codecRead.resolve(dv([OMI_CODEC.OPUS_16K]));
    await expect(staleRead).rejects.toThrow("superseded");
  });
});
