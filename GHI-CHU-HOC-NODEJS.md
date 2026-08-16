# Ghi chú học Node.js — dự án hoanglam-bank

Tổng hợp lại toàn bộ những gì đã học, để đọc lại bất cứ lúc nào không cần hỏi lại từ đầu.

## 1. Kiến trúc tổng thể

- **backend/** — Node.js + Express + TypeScript + Prisma. Chạy `npm run dev` (lệnh khai báo trong `package.json`), nghe ở `http://localhost:4000`.
- **frontend/** — Next.js (React). Gọi API của backend qua `lib/api.ts`.
- Frontend và backend là 2 chương trình tách biệt, nói chuyện với nhau qua HTTP request/response (dạng JSON).

## 2. Từ vựng JavaScript/TypeScript cơ bản

| Khái niệm | Ý nghĩa | Ví dụ |
|---|---|---|
| `const` / `let` | Tạo biến. `const` không đổi được, `let` đổi được | `const PORT = 4000;` |
| string / number / boolean | 3 kiểu dữ liệu cơ bản | `"abc"`, `4000`, `true` |
| `if / else` | Rẽ nhánh, làm A hay B tuỳ điều kiện | `if (!token) { ... }` |
| Object `{ }` | Gói nhiều thông tin liên quan, dạng `tên: giá trị` | `{ id: "1", name: "Lam" }` |
| Array `[ ]` | Danh sách nhiều phần tử/object | `[acc1, acc2]` |
| Function | Khối code tái sử dụng được, nhận input trả output | `(a, b) => a + b` |
| Destructuring | Bóc nhanh dữ liệu từ object/array ra biến riêng | `const { token } = useAuth();` |
| `async/await` | Chờ 1 việc mất thời gian (gọi API, DB) mà không làm đơ chương trình | `const data = await fetch(...)` |
| `interface` (TS) | Khuôn mẫu mô tả hình dạng object, chỉ để báo lỗi lúc viết code | `interface User { id: string }` |

## 3. Express (backend server)

- `const app = express()` — tạo server. `app.listen(PORT)` — bật server chạy.
- `app.use(X)` — middleware, chạy cho **mọi** request, không phân biệt GET/POST.
- `app.get(path, fn)` / `app.post(path, fn)` — chỉ chạy khi **đúng path VÀ đúng phương thức**.
- Request đi qua các dòng `app.use`/`app.get`/`app.post` **theo đúng thứ tự khai báo trong code, từ trên xuống**. Không khớp thì tự bỏ qua, thử dòng kế. Khớp và có `res.json(...)` thì dừng lại, không chạy tiếp các dòng dưới.
- `Router()` — gom nhiều route liên quan vào 1 file riêng (vd `routes/auth.ts`), rồi gắn vào app bằng `app.use("/api/auth", authRoutes)` (mọi route bên trong tự có tiền tố `/api/auth`).
- `router.use(requireAuth)` đặt đầu file — áp middleware cho **cả router**, không cần lặp lại từng route.
- Middleware xếp chồng: `router.post("/", requireCompanyAdmin, async (req, res) => {...})` — request phải qua hết `requireAuth` → `requireCompanyAdmin` → mới tới hàm xử lý chính.
- `req.body` — dữ liệu gửi trong thân request (cần `express.json()` ở đầu để đọc được).
- `req.params.id` — dữ liệu nằm ngay trên URL, khai báo bằng dấu `:` trong path (`router.delete("/:id", ...)`).
- Middleware (`requireAuth`) gắn thêm thông tin vào `req` (vd `req.userId`, `req.companyId`) để các bước xử lý sau dùng lại.

**Xử lý lỗi:**
- Error middleware ở cuối `index.ts` (nhận đủ 4 tham số `(err, req, res, next)`) — bắt lỗi từ mọi route, ghi log, trả `500`, không để sập cả server.
- `process.on("unhandledRejection", ...)` — lưới an toàn cuối cùng cho các lỗi `async` mà Express không bắt kịp.

## 4. Prisma (nói chuyện với database)

- `schema.prisma` — "bản vẽ" các bảng (giống thiết kế cột trong Excel) trước khi dùng.
- `model User { ... }` — định nghĩa 1 bảng, mỗi dòng là 1 cột + kiểu dữ liệu. `?` = có thể để trống, không có `?` = bắt buộc.
- Quan hệ 2 bảng: cột lưu id của bảng kia (vd `companyId` trong `User`) là cột **thật**; còn `users User[]` bên `Company` chỉ là Prisma tự lọc giúp, không tốn chỗ lưu.
- Câu lệnh chung: `prisma.<bảng>.<hànhĐộng>({ where, data, include })`
  - `findUnique` — tìm đúng 1 dòng theo cột `@unique`/`@id`.
  - `findFirst` — tìm 1 dòng theo điều kiện bất kỳ.
  - `findMany` — tìm nhiều dòng, trả về mảng.
  - `create` — tạo dòng mới (có thể tạo lồng bảng liên quan cùng lúc).
  - `update` — sửa dòng đã có (`decrement`/`increment` để cộng/trừ dựa trên giá trị hiện tại).
  - `delete` / `deleteMany` — xoá dòng.
  - `include` — kéo thêm dữ liệu bảng liên quan vào kết quả trả về.
- `prisma.$transaction(async (tx) => { ... })` — gói nhiều thao tác ghi database vào 1 khối: **hoặc tất cả cùng thành công, hoặc không cái nào xảy ra** (dùng khi 1 hành động phải sửa nhiều chỗ cùng lúc, như chuyển tiền giữa 2 tài khoản).

## 5. Khuôn mẫu chung của 1 route (áp dụng ~90% route trong dự án)

```
1. Validate dữ liệu đầu vào (zod schema, safeParse) → sai thì trả 400, dừng lại
2. Kiểm tra nghiệp vụ (tồn tại chưa, đủ quyền chưa, đủ số dư chưa...) → sai thì trả lỗi tương ứng, dừng lại
3. Đọc/ghi database qua Prisma (await)
4. Trả kết quả về bằng res.json(...) hoặc res.status(...).json(...)
```

## 6. Luồng đăng nhập, tóm tắt

1. Người dùng bấm "Đăng nhập" ở frontend (`login/page.tsx`)
2. `login()` trong `auth-context.tsx` gọi `api.post("/auth/login", { email, password })`
3. Backend (`routes/auth.ts`) kiểm tra email/password, tạo token (`signToken`)
4. Frontend nhận `{ token, user, company }`, lưu token vào `localStorage` + state
5. Từ đó, mọi request khác tự động gắn `Authorization: Bearer <token>` — backend dùng `requireAuth` để kiểm tra token này trước khi cho vào route

## 7. React / Next.js (frontend)

- **Component** — 1 function trả về giao diện (JSX) thay vì trả về số/chuỗi. Có thể tái sử dụng như function bình thường.
- **JSX** — cú pháp trộn thẻ giống HTML vào trong JS/TS. Dùng `{ }` để chèn giá trị JS (biến, biểu thức) vào giữa JSX, vd `<h1>Xin chào, {user.name}</h1>`.
- **Props** — cách truyền dữ liệu vào component, giống tham số hàm nhưng viết dạng `<Component thuộcTính={giá trị} />`.
- **`useState(giá trị đầu)`** — tạo 1 "hộp nhớ" có kết nối với React, trả về `[giá trị hiện tại, hàm để đổi giá trị]`. Đổi giá trị **phải** qua hàm `set...`, không được gán trực tiếp — chỉ vậy React mới biết để vẽ lại giao diện.
- **`useEffect(fn, [deps])`** — chạy `fn` (thường là gọi API, đọc localStorage...) sau khi component vẽ xong. Chạy lại mỗi khi giá trị trong mảng `[deps]` thay đổi; mảng rỗng `[]` = chỉ chạy 1 lần lúc mới xuất hiện.
- **Re-render (vẽ lại)** — mỗi khi state đổi (`setX(...)`), component chạy lại từ đầu, tạo ra JSX mới. React so sánh JSX mới với JSX cũ (Virtual DOM), chỉ cập nhật đúng phần khác biệt lên trang thật — không vẽ lại toàn bộ.
- **`key`** — khi vẽ danh sách bằng `.map()`, mỗi phần tử cần 1 `key` riêng biệt để React so sánh đúng phần tử nào ứng với phần tử nào giữa 2 lần vẽ.
- **File-based routing (Next.js)** — cấu trúc thư mục trong `src/app/` = cấu trúc URL. `page.tsx` trong 1 thư mục tạo ra 1 trang; `layout.tsx` là khung bao quanh mọi trang con; thư mục `(tên)` (ngoặc đơn) chỉ để tổ chức code, không xuất hiện trong URL.

**Khuôn mẫu chung của 1 trang cần dữ liệu (áp dụng hầu hết page trong dự án):**
```tsx
"use client";
export default function SomePage() {
  const { token } = useAuth();               // lấy trạng thái đăng nhập dùng chung
  const [data, setData] = useState([]);       // hộp nhớ chứa dữ liệu
  useEffect(() => {
    api.get("/some-endpoint", token).then((d) => setData(d.items));
  }, [token]);                                 // gọi API khi có token
  return <div>{data.map((x) => <div key={x.id}>{x.name}</div>)}</div>;  // vẽ ra
}
```

## 8. Từ điển thuật ngữ nhanh

- **API** — nơi 2 chương trình (frontend/backend) gọi nhau qua các "đường dẫn" quy ước sẵn.
- **Endpoint** — 1 đường dẫn API cụ thể, vd `POST /api/auth/login`.
- **Token** — "vé vào cửa" xác nhận đã đăng nhập, không cần gửi lại mật khẩu mỗi lần.
- **Middleware** — hàm chạy chen giữa, trước khi tới logic chính (kiểm tra, log, parse dữ liệu).
- **Request / Response** — request là điều client gửi lên, response là điều server trả về.
- **ORM** (Prisma là 1 loại) — công cụ dịch code thành câu lệnh database, không cần viết SQL tay.
