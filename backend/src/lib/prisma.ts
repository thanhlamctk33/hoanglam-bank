import { PrismaClient } from "@prisma/client";

/**
 * Lazily-constructed PrismaClient singleton.
 *
 * `new PrismaClient()` eagerly loads the native query engine, so building it
 * at module scope meant that merely *importing* any repository — as a unit
 * test does when it imports a service — spun up the engine and failed on any
 * machine without a matching generated client. Going through a Proxy defers
 * construction to the first actual query, so import graphs stay cheap and
 * tests that mock their repository never touch a database at all.
 *
 * Callers see the normal `prisma.model.method()` API and don't need to know
 * this is deferred.
 */
let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(getClient(), property, receiver);
    // Model delegates and helpers like $transaction must stay bound to the
    // real client, not to the Proxy.
    return typeof value === "function" ? value.bind(getClient()) : value;
  },
});
