# Node.js Learning Notes — hoanglam-bank project

A summary of everything learned so far, to reread at any time without having to ask again from scratch.

## 1. Overall architecture

- **backend/** — Node.js + Express + TypeScript + Prisma. Run `npm run dev` (the command is declared in `package.json`); it listens on `http://localhost:4000`.
- **frontend/** — Next.js (React). Calls the backend API through `lib/api.ts`.
- The frontend and backend are 2 separate programs that talk to each other via HTTP requests/responses (in JSON).

## 2. Basic JavaScript/TypeScript vocabulary

| Concept | Meaning | Example |
|---|---|---|
| `const` / `let` | Declare a variable. `const` can't be reassigned, `let` can | `const PORT = 4000;` |
| string / number / boolean | The 3 basic data types | `"abc"`, `4000`, `true` |
| `if / else` | Branching: do A or B depending on a condition | `if (!token) { ... }` |
| Object `{ }` | Bundles related pieces of information as `name: value` | `{ id: "1", name: "Lam" }` |
| Array `[ ]` | A list of elements/objects | `[acc1, acc2]` |
| Function | A reusable block of code that takes input and returns output | `(a, b) => a + b` |
| Destructuring | Quickly pull data out of an object/array into separate variables | `const { token } = useAuth();` |
| `async/await` | Wait for something slow (an API call, a DB query) without freezing the program | `const data = await fetch(...)` |
| `interface` (TS) | A template describing the shape of an object, used only to report errors while writing code | `interface User { id: string }` |

## 3. Express (backend server)

- `const app = express()` — creates the server. `app.listen(PORT)` — starts the server.
- `app.use(X)` — middleware; runs for **every** request, regardless of GET/POST.
- `app.get(path, fn)` / `app.post(path, fn)` — only runs when **both the path AND the method match**.
- A request passes through the `app.use`/`app.get`/`app.post` lines **in exactly the order they are declared in the code, top to bottom**. If a line doesn't match, it's skipped and the next one is tried. If it matches and calls `res.json(...)`, processing stops and the lines below don't run.
- `Router()` — groups related routes into their own file (e.g. `routes/auth.ts`), which is then attached to the app with `app.use("/api/auth", authRoutes)` (every route inside automatically gets the `/api/auth` prefix).
- `router.use(requireAuth)` at the top of a file — applies the middleware to **the whole router**, so it doesn't have to be repeated on each route.
- Stacked middleware: `router.post("/", requireCompanyAdmin, async (req, res) => {...})` — the request must pass through `requireAuth` → `requireCompanyAdmin` before it reaches the main handler.
- `req.body` — data sent in the request body (needs `express.json()` at the top to be readable).
- `req.params.id` — data that sits right in the URL, declared with a `:` in the path (`router.delete("/:id", ...)`).
- Middleware (`requireAuth`) attaches extra information to `req` (e.g. `req.userId`, `req.companyId`) so later steps can reuse it.

**Error handling:**
- The error middleware at the end of `index.ts` (takes all 4 parameters `(err, req, res, next)`) — catches errors from every route, logs them, returns `500`, and keeps the whole server from crashing.
- `process.on("unhandledRejection", ...)` — the last safety net for `async` errors that Express doesn't catch.

## 4. Prisma (talking to the database)

- `schema.prisma` — the "blueprint" of the tables (like designing columns in Excel) before using them.
- `model User { ... }` — defines 1 table; each line is 1 column + its data type. `?` = may be empty, no `?` = required.
- Relations between 2 tables: the column storing the other table's id (e.g. `companyId` in `User`) is a **real** column; `users User[]` on `Company` is just Prisma filtering for you, it takes no storage.
- General command shape: `prisma.<table>.<action>({ where, data, include })`
  - `findUnique` — find exactly 1 row by an `@unique`/`@id` column.
  - `findFirst` — find 1 row by any condition.
  - `findMany` — find many rows, returns an array.
  - `create` — create a new row (can create nested related-table rows at the same time).
  - `update` — modify an existing row (`decrement`/`increment` add/subtract based on the current value).
  - `delete` / `deleteMany` — delete rows.
  - `include` — pull data from related tables into the returned result.
- `prisma.$transaction(async (tx) => { ... })` — wraps several database writes into 1 block: **either all of them succeed, or none of them happen** (used when 1 action must change several places at once, such as moving money between 2 accounts).

## 5. The common pattern of a route (applies to ~90% of routes in the project)

```
1. Validate the input (zod schema, safeParse) → if invalid, return 400 and stop
2. Business checks (does it exist, enough permission, enough balance...) → if not, return the matching error and stop
3. Read/write the database via Prisma (await)
4. Return the result with res.json(...) or res.status(...).json(...)
```

## 6. Login flow, summarized

1. The user clicks "Log in" on the frontend (`login/page.tsx`)
2. `login()` in `auth-context.tsx` calls `api.post("/auth/login", { email, password })`
3. The backend (`routes/auth.ts`) checks the email/password and creates a token (`signToken`)
4. The frontend receives `{ token, user, company }` and stores the token in `localStorage` + state
5. From then on, every other request automatically attaches `Authorization: Bearer <token>` — the backend uses `requireAuth` to check this token before letting the request into the route

## 7. React / Next.js (frontend)

- **Component** — a function that returns UI (JSX) instead of a number/string. It can be reused like a normal function.
- **JSX** — syntax that mixes HTML-like tags into JS/TS. Use `{ }` to insert JS values (variables, expressions) inside JSX, e.g. `<h1>Hello, {user.name}</h1>`.
- **Props** — the way to pass data into a component, like function parameters but written as `<Component attribute={value} />`.
- **`useState(initialValue)`** — creates a "memory box" connected to React, returns `[current value, function to change the value]`. The value **must** be changed through the `set...` function, never assigned directly — only then does React know to redraw the UI.
- **`useEffect(fn, [deps])`** — runs `fn` (usually an API call, reading localStorage...) after the component has rendered. Runs again whenever a value in the `[deps]` array changes; an empty array `[]` = run only once, when it first appears.
- **Re-render** — every time state changes (`setX(...)`), the component runs again from the top and produces new JSX. React compares the new JSX with the old JSX (Virtual DOM) and only updates the parts that differ on the real page — it doesn't redraw everything.
- **`key`** — when rendering a list with `.map()`, each element needs a unique `key` so React can correctly match which element corresponds to which between 2 renders.
- **File-based routing (Next.js)** — the folder structure in `src/app/` = the URL structure. A `page.tsx` in a folder creates a page; `layout.tsx` is the frame around all child pages; a `(name)` folder (in parentheses) is only for organizing code and doesn't appear in the URL.

**The common pattern of a page that needs data (applies to most pages in the project):**
```tsx
"use client";
export default function SomePage() {
  const { token } = useAuth();               // get the shared login state
  const [data, setData] = useState([]);       // memory box holding the data
  useEffect(() => {
    api.get("/some-endpoint", token).then((d) => setData(d.items));
  }, [token]);                                 // call the API once there is a token
  return <div>{data.map((x) => <div key={x.id}>{x.name}</div>)}</div>;  // render it
}
```

## 8. Quick glossary

- **API** — where 2 programs (frontend/backend) call each other through agreed-upon "paths".
- **Endpoint** — 1 specific API path, e.g. `POST /api/auth/login`.
- **Token** — an "entry ticket" proving you're logged in, so the password doesn't have to be sent every time.
- **Middleware** — a function that runs in between, before the main logic (checks, logging, parsing data).
- **Request / Response** — the request is what the client sends; the response is what the server returns.
- **ORM** (Prisma is one) — a tool that translates code into database commands, so you don't have to write SQL by hand.
