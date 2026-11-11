# Hướng dẫn sử dụng canva-mcp

> Tài liệu tiếng Việt. Bản tham chiếu kỹ thuật tiếng Anh nằm ở [README.md](README.md).

## Mục lục

1. [canva-mcp là gì](#1-canva-mcp-là-gì)
2. [Cách hoạt động](#2-cách-hoạt-động)
3. [Cài đặt](#3-cài-đặt)
4. [Sử dụng hằng ngày](#4-sử-dụng-hằng-ngày)
5. [Tính năng](#5-tính-năng)
6. [Giới hạn (limitations)](#6-giới-hạn-limitations)
7. [Xử lý sự cố](#7-xử-lý-sự-cố)
8. [Cấu hình](#8-cấu-hình)
9. [Bảo mật](#9-bảo-mật)
10. [Phát triển và kiểm thử](#10-phát-triển-và-kiểm-thử)

---

## 1. canva-mcp là gì

canva-mcp là một **MCP server tự host** cho Canva. Nó chạy trên máy của bạn và cho phép trợ lý AI (Claude Code, Claude Desktop, Cursor… hoặc bất kỳ MCP client nào) làm việc với tài khoản Canva của bạn: tìm thiết kế, tạo mới, xuất file, quản lý thư mục, bình luận, và **sửa trực tiếp nội dung bên trong trang** đang mở trong trình duyệt.

Điểm khác so với connector Canva chính thức:

- Dùng **integration (app) Canva của chính bạn** và đăng nhập OAuth của bạn. Không qua máy chủ trung gian nào.
- Tên công cụ giống bản chính thức nhưng có tiền tố `canva_local_` (ví dụ `canva_local_search-designs`), nên có thể chạy song song với connector chính thức mà không trùng tên.
- Có thêm **editing bridge**: một app Canva nhỏ chạy trong editor, cho phép đọc và sửa từng phần tử (chữ, hình, màu, vị trí…) trên trang. Connect REST API công khai của Canva không làm được việc này.

---

## 2. Cách hoạt động

### Tổng quan kiến trúc

```
MCP client (Claude Code, Claude Desktop, Cursor…)
        │ stdio
        ▼
   canva-mcp ──── HTTPS ────► api.canva.com/rest/v1/*          (Bearer access token)
        │
        ├── ~/.canva-mcp/tokens.json                           (access + refresh token, tự gia hạn)
        ├── http://127.0.0.1:3001/oauth/redirect ◄── trình duyệt (chỉ trong lúc đăng nhập)
        │
        ├── http://localhost:8080 ──────► Canva editor            (phục vụ app "canva-mcp bridge", nếu dùng Development URL)
        └── ws://localhost:3860 / wss://localhost:3861 ◄── bridge app trong editor   (đọc và sửa trang đang mở)
```

canva-mcp làm việc theo **hai đường**:

| | Đường REST API | Đường editing bridge |
| --- | --- | --- |
| Làm được gì | Thao tác trên **cả thiết kế**: tìm, tạo, sao chép, resize, gộp trang, xuất, nhập, upload, thư mục, bình luận, brand template, autofill | Thao tác **bên trong một trang**: đọc phần tử, sửa chữ, định dạng, đổi màu, di chuyển, xóa, nhóm, chèn chữ/hình/ảnh |
| Cần gì | Đã đăng nhập OAuth | Thiết kế đang mở trong Chrome/Edge **và** panel app "canva-mcp bridge" đang mở |
| Nằm ở đâu trong mã | `src/canva/`, `src/tools/*.ts` | `src/bridge/`, `src/tools/editor.ts`, `bridge-app/` |

### Đăng nhập và token

- Đăng nhập dùng **OAuth 2.0 authorization code + PKCE**. Lệnh `npm run login` (hoặc công cụ `canva_local_login`) mở trang đồng ý của Canva trong trình duyệt. Sau khi bạn bấm **Allow**, Canva chuyển hướng về `http://127.0.0.1:3001/oauth/redirect`, và canva-mcp lưu token vào `~/.canva-mcp/tokens.json`.
- Access token sống khoảng **4 giờ**. canva-mcp tự gia hạn khi token còn dưới 1 phút, và thử gia hạn lại một lần nếu Canva trả về 401.
- Refresh token của Canva **chỉ dùng được một lần**. Vì vậy file token được ghi lại sau mỗi lần gia hạn (ghi qua file tạm rồi đổi tên, tránh hỏng file), dưới một **khóa liên tiến trình** (`tokens.json.lock`). Nhiều phiên Claude có thể chạy canva-mcp cùng lúc mà không làm nhau bị đăng xuất.

### Job bất đồng bộ

Các thao tác dài (xuất file, nhập file, upload, autofill, resize, gộp trang, AI generation) là job bất đồng bộ phía Canva. canva-mcp tự chờ kết quả. Nếu sau `CANVA_JOB_TIMEOUT_MS` (mặc định 90 giây) job vẫn chạy, công cụ trả về `jobId` và bạn (hoặc Claude) tiếp tục bằng `canva_local_get-job`.

Khi Canva báo **429 (rate limit)**, canva-mcp thử lại tối đa 3 lần theo header `Retry-After` (mỗi lần chờ tối đa 20 giây), rồi mới báo lỗi.

### Editing bridge

1. Bạn mở một thiết kế trong Chrome hoặc Edge và mở app **canva-mcp bridge** từ panel Apps.
2. App (viết bằng Canva Apps SDK, [Design Editing API](https://canva.dev/docs/apps/design-editing)) mở một WebSocket về canva-mcp trên máy bạn:
   - `ws://localhost:3860` nếu app được nạp từ **Development URL**;
   - `wss://localhost:3861` nếu app được **upload bundle** lên Developer Portal (chính sách CSP của Canva chặn `ws://` với app đã upload).
3. Khi Claude gọi `read-page` hoặc `edit-page`, canva-mcp gửi yêu cầu qua WebSocket. App thực hiện nó trong editor bằng SDK và trả kết quả về.

Một số chi tiết quan trọng:

- **Chỉ app của bạn được kết nối.** canva-mcp chỉ nhận kết nối từ origin trong `CANVA_BRIDGE_APP_ORIGIN` (dạng `https://app-xxxxxxxx.canva-apps.com`). Website khác và app Canva khác bị từ chối. Các cổng chỉ lắng nghe trên loopback (`127.0.0.1` và `::1`).
- **Đường dẫn (path) và khóa (key).** `read-page` trả về danh sách phần tử. Mỗi phần tử có `path` (vị trí: `"3"` là phần tử thứ 4 trên trang, `"3.1"` là phần tử thứ 2 trong nhóm `3`) và `key` (dấu vân tay của loại, vị trí, kích thước, góc xoay và nội dung chữ). Khi `edit-page` nhận `key`, nếu phần tử đã thay đổi kể từ lúc đọc thì cả batch bị từ chối thay vì sửa nhầm.
- **Tất cả hoặc không có gì.** Một batch chỉ được lưu khi mọi thao tác thành công. Batch lỗi không để lại thay đổi nào. Mỗi batch đã lưu có thể hoàn tác trong editor bằng **Ctrl+Z**.
- **`dryRun`.** Chạy thử batch trong phiên nháp và trả kết quả mà không lưu.
- **Nhiều phiên Claude.** Phiên canva-mcp đầu tiên giữ các cổng ("owner"). Các phiên sau kết nối vào owner và chuyển tiếp yêu cầu qua nó ("relay"), xác thực bằng một bí mật chung trong `~/.canva-mcp/bridge-secret`. Khi owner thoát, phiên kế tiếp tự lên thay, và panel app tự kết nối lại.
- **Tốc độ.** Thao tác chạy ngay trong trình duyệt, không chịu rate limit theo gói Canva. Đo được khoảng 3 ms mỗi vòng ping và khoảng 130 ms cho một lần chèn rồi sửa chữ (xem [SPIKE.md](SPIKE.md)).

---

## 3. Cài đặt

### Yêu cầu

- **Node.js 22** trở lên.
- Một tài khoản Canva. Một số tính năng cần gói trả phí (xem [mục 6](#6-giới-hạn-limitations)).
- Chrome hoặc Edge (để dùng editing bridge).

### Bước 1. Cài và build

```bash
git clone https://github.com/deniahc566/CanvaMCP-CustomApp.git
```

```bash
cd CanvaMCP-CustomApp
```

```bash
npm install
```

```bash
npm run build
```

`npm install` cũng cài dependency cho `bridge-app/`. `npm run build` biên dịch server vào `dist/` và đóng gói app bridge vào `bridge-app/dist/app.js`.

### Bước 2. Tạo integration trên Canva Developer Portal

1. Mở [Canva Developer Portal](https://www.canva.com/developers/) và tạo app. Chọn **Public** (trừ khi team bạn dùng Canva Enterprise và muốn app private). Canva chỉ review app public trước khi *người khác* kết nối, nên bạn không cần submit để dùng với tài khoản của mình.
2. Trong mục **Outside Canva**, bấm **Start integrating**. Thao tác này tạo OAuth client và mở trang **Configuration**.
3. Trong **Integration methods**, bật **Canva REST APIs**.
4. Trong **Credentials**, chép **Client ID**, rồi bấm **Generate secret** và chép secret. Canva chỉ hiện secret một lần.
5. Trong **Scopes**, tick các scope sau:

   | Scope | Dùng cho |
   | --- | --- |
   | design:meta (Read) | search-designs, get-design, trạng thái autofill |
   | design:content (Read + Write) | trang, thumbnail, export, create/copy/resize/merge/generate, import, autofill |
   | folder (Read + Write) | list-folder-items, create-folder, move-item-to-folder |
   | asset (Read + Write) | upload, get-assets, update-asset, generate-image, remove-background |
   | comment (Read + Write) | các công cụ bình luận |
   | brandtemplate:meta (Read), brandtemplate:content (Read) | tìm brand template và dataset |
   | profile (Read) | whoami (tên hiển thị, capabilities) |
   | brandtemplate:content (Write), tùy chọn | publish-brand-template; khi bật thì thêm cả vào `CANVA_SCOPES` |

6. Trong **Redirect URLs**, đặt **URL 1** là `http://127.0.0.1:3001/oauth/redirect`. Giá trị này phải khớp chính xác với `CANVA_REDIRECT_URI`, kể cả cổng và đường dẫn.

Nếu bỏ tick scope nào, hãy xóa scope đó khỏi `CANVA_SCOPES`. Nếu không, trang đăng nhập sẽ xin một scope mà integration không có và báo lỗi.

### Bước 3. Điền thông tin đăng nhập

Sao chép `.env.example` thành `.env` trong thư mục dự án, rồi điền `CANVA_CLIENT_ID` và `CANVA_CLIENT_SECRET`. Server đọc `.env` từ chính thư mục của nó. Biến môi trường đã đặt sẵn (ví dụ qua `claude mcp add -e`) được ưu tiên hơn `.env`.

> `.env` đã nằm trong `.gitignore`. Đừng commit file này.

### Bước 4. Đăng nhập Canva

```bash
npm run login
```

Trình duyệt mở trang đồng ý của Canva. Bấm **Allow**; terminal xác nhận token đã lưu vào `~/.canva-mcp/tokens.json`. Kiểm tra trạng thái bất cứ lúc nào:

```bash
npm run status
```

Bạn cũng có thể bỏ qua bước này và nói với Claude "đăng nhập Canva". Claude gọi `canva_local_login`, chạy đúng quy trình trên.

### Bước 5. Đăng ký server với MCP client

**Claude Code** (scope user, mọi dự án đều dùng được). Thay đường dẫn bằng thư mục bạn đã clone:

```bash
claude mcp add canva-local -s user -- node D:/CanvaMCP/dist/index.js
```

**Claude Desktop, Cursor** và các client cấu hình bằng JSON:

```json
{
  "mcpServers": {
    "canva-local": {
      "command": "node",
      "args": ["D:/CanvaMCP/dist/index.js"]
    }
  }
}
```

Thông tin đăng nhập lấy từ `.env`. Nếu muốn để trong cấu hình client, thêm `"env": { "CANVA_CLIENT_ID": "…", "CANVA_CLIENT_SECRET": "…" }`, hoặc dùng `-e` với `claude mcp add`.

### Bước 6. Cài editing bridge (tùy chọn, cần để sửa nội dung trang)

1. Trong [Developer Portal](https://www.canva.com/developers/apps), mở **cùng app đó**. Trong mục **Inside Canva**:
   - **Intents:** bấm **Set up** cạnh **Design Editor**.
   - **Permissions:** bật `canva:design:content:read`, `canva:design:content:write`, và `canva:asset:private:write` (cần cho `insert_image`, vì ảnh được upload vào Uploads của bạn trước khi đặt lên trang).
   - **Code upload → App source:** chọn một trong hai cách ở bảng dưới.
2. Chép origin của app vào `.env` thành `CANVA_BRIDGE_APP_ORIGIN`. Nó có dạng `https://app-xxxxxxxx.canva-apps.com`. Panel bridge hiển thị nó ở dòng **App origin**; nó cũng nằm trong mục **Security** của Developer Portal.
3. Mở một thiết kế trong Chrome hoặc Edge. Bấm **Preview** trong Developer Portal, hoặc mở **canva-mcp bridge** từ panel Apps của editor. Panel báo **Connected** khi canva-mcp đang chạy. canva-mcp khởi động cùng Claude, và panel tự thử lại cho đến khi kết nối được.

| | Upload bundle (khuyến nghị) | Development URL |
| --- | --- | --- |
| Thiết lập | Để trống **Development URL** và upload `bridge-app/dist/app.js`. Development URL được ưu tiên khi có giá trị. | Đặt **Development URL** là `http://localhost:8080`. |
| Khi Claude chưa chạy | Panel vẫn tải được và chờ canva-mcp. | Panel lỗi "couldn't load the app's JavaScript bundle"; tải lại panel sau khi Claude chạy. |
| Kết nối | Chỉ `wss://localhost:3861`. Chính sách của Canva chặn `ws://` với app đã upload. | `ws://localhost:3860`, không cần chứng chỉ. |
| Mỗi phiên trình duyệt | Chấp nhận chứng chỉ tự ký của bridge: bấm **Open certificate page** trong panel, hoặc mở https://localhost:3861, rồi chọn **Advanced → Continue**. | Cho phép truy cập mạng cục bộ khi Chrome/Edge hỏi. |
| Sau khi sửa `bridge-app/` | Chạy `npm run build` rồi **upload lại** `app.js`. Chỉ tải lại panel là chưa đủ. | Tải lại panel. |

**Không muốn chấp nhận chứng chỉ mỗi phiên?** Dùng chứng chỉ mà hệ thống tin cậy, tạo bằng [mkcert](https://github.com/FiloSottile/mkcert). Bước `mkcert -install` thêm một CA cục bộ vào kho tin cậy của máy, hãy cân nhắc trước khi làm. Sau đó chạy:

```bash
mkcert localhost 127.0.0.1 ::1
```

và đặt `CANVA_BRIDGE_CERT`, `CANVA_BRIDGE_KEY` trong `.env` trỏ tới hai file nó tạo ra.

### Bước 7. Kiểm tra bridge

```bash
npm run try-bridge
```

Lệnh này đọc trang đang mở mà không thay đổi gì. `npm run try-bridge -- --edit` chạy thêm một loạt thao tác sửa thử; chỉ dùng trên thiết kế nháp.

---

## 4. Sử dụng hằng ngày

Bạn ra lệnh cho Claude bằng ngôn ngữ tự nhiên; Claude tự chọn công cụ. Ví dụ:

| Bạn nói | Claude dùng |
| --- | --- |
| "Tìm các thiết kế có chữ 'báo cáo quý' trong tên" | `search-designs` |
| "Cho tôi xem thiết kế này" + dán link canva.com | `get-design`, `get-design-thumbnail` |
| "Xuất thiết kế này ra PDF và lưu về máy" | `export-design` với `download: true` |
| "Nhập file slides.pptx này vào Canva" | `import-design-from-file` |
| "Tạo thư mục 'Dự án 2026' và chuyển 3 thiết kế này vào" | `create-folder`, `move-item-to-folder` |
| "Đổi tiêu đề trang 2 thành ..." | `editor-status` → `read-page` → `edit-page` |
| "Thêm 2 trang trống sau trang 5" | `create-design` + `merge-designs` |

### Quy trình sửa nội dung trang

1. Mở thiết kế trong Chrome/Edge, mở panel **canva-mcp bridge**, chờ chữ **Connected**.
2. Claude gọi `editor-status` để biết thiết kế nào, trang nào đang mở, và danh sách trang.
3. Claude gọi `read-page` (có thể chỉ định `page`, và `formatting: true` để xem định dạng chi tiết).
4. Claude gọi `edit-page` với một batch thao tác, dùng `path` và `key` vừa đọc. Có thể chạy `dryRun: true` trước.
5. Thay đổi hiện ngay trong editor của bạn. Muốn bỏ thì bấm Ctrl+Z.

Mẹo:

- Nếu bạn vừa tự sửa tay trong Canva, hãy để Claude **đọc lại trang** trước khi sửa tiếp. Key của phần tử thay đổi sau mỗi lần lưu.
- Đừng để Claude gọi `read-page`/`edit-page` song song. Editor chỉ cho mở một phiên chỉnh sửa tại một thời điểm.

### Thêm, xóa, sắp xếp trang

`edit-page` không có thao tác cấp trang. Dùng `merge-designs` trên chính thiết kế đó:

- **Thêm trang trống:** tạo một thiết kế trống cùng kích thước bằng `create-design`, rồi `insert_pages` từ thiết kế đó, lặp số trang để thêm nhiều trang một lúc (ví dụ `pageNumbers: [1,1,1]`, `afterPageNumber: 5`). Thiết kế trống phụ này vẫn nằm trong tài khoản Canva của bạn; xóa nó nếu không cần.
- **Nhân bản trang có sẵn nền/logo:** `insert_pages` từ chính thiết kế đó, rồi xóa nội dung cũ. Trang trống không có ảnh nền, và `edit-page` không đặt được ảnh nền.
- **Xóa trang:** `delete_pages`.
- **Đổi thứ tự:** `move_pages`. Nên diễn đạt thành thao tác chuyển trang **về phía sau** và kiểm tra lại bằng `editor-status`; chuyển về phía trước từng cho thứ tự sai.

### Chuyển slide SVG thành phần tử Canva

`scripts/svg2canva.mjs` dựng lại các slide SVG thành phần tử Canva gốc, chỉnh sửa được, trên các trang của thiết kế đang mở. Công cụ được viết cho thư mục `svg_output` của ppt-master. Cần editing bridge, và chạy được trong lúc Claude đang dùng canva-mcp.

```bash
npm run svg2canva -- <thư mục svg> [ánh xạ ...] [tùy chọn]
```

- Slide là các file `.svg` trong thư mục, theo thứ tự tên. Không có ánh xạ thì slide 1 vào trang 1, slide 2 vào trang 2…
- `3:7` đặt slide 3 vào trang 7. `2-5:10` đặt slide 2–5 vào trang 10–13. Các trang phải có sẵn.
- Mỗi slide được co giãn cho vừa trang.

| Tùy chọn | Tác dụng |
| --- | --- |
| `--replace` | Xóa nội dung các trang đích đang có. Không có cờ này, script từ chối trước khi thay đổi gì. |
| `--check` | Kiểm tra mọi batch bằng dry run trong Canva. Không thay đổi gì. |
| `--dry` | Chuyển đổi không cần Canva và liệt kê mỗi slide thành gì. |
| `--out <dir>` | Lưu thao tác của từng slide ra JSON. |
| `--font-scale`, `--ascent` | Hiệu chỉnh chữ. Mặc định (0.94, 0.95) đo cho slide Segoe UI dựng bằng font mặc định của Canva. |

---

## 5. Tính năng

Tên công cụ dưới đây bỏ tiền tố `canva_local_`. Cột **Chính thức** đánh dấu công cụ trùng tên với Canva MCP chính thức.

### Tài khoản và tiện ích

| Công cụ | Chính thức | Chức năng |
| --- | --- | --- |
| `whoami` | | Trạng thái đăng nhập, user/team ID, tên hiển thị, scope, capabilities của gói. |
| `login` | | Mở trang đồng ý của Canva và chờ bạn duyệt. |
| `resolve-shortlink` | ✓ | Mở rộng link `canva.link` và trả về design ID. |
| `get-job` | | Tiếp tục một job bất đồng bộ mà công cụ khác trả về khi chưa xong. |

### Thiết kế

| Công cụ | Chính thức | Chức năng |
| --- | --- | --- |
| `search-designs` | ✓ | Tìm hoặc liệt kê thiết kế, lọc theo quyền sở hữu, sắp xếp, phân trang. |
| `get-design` | ✓ | Metadata, link edit/view, URL thumbnail. |
| `get-design-pages` | ✓ | Số trang, kích thước, thumbnail. *Preview API.* |
| `get-design-thumbnail` | ✓ | Trả về **ảnh** thumbnail để Claude "nhìn" thiết kế. |
| `get-export-formats` | ✓ | Thiết kế xuất được sang định dạng nào. |
| `create-design` | ✓ | Thiết kế trống theo preset (doc, email, presentation, whiteboard) hoặc kích thước tùy chọn, có thể kèm ảnh. |
| `copy-design` | ✓ | Sao chép thiết kế hoặc một số trang. *Preview API.* |
| `create-design-from-brand-template` | ✓ | Bản sao của brand template. *Preview API; gói có brand template.* |
| `resize-design` | ✓ | Magic Resize sang preset hoặc kích thước tùy chọn. *Pro trở lên (Free có dùng thử).* |
| `merge-designs` | ✓ | Thiết kế mới từ trang của thiết kế khác, hoặc chèn/di chuyển/xóa trang tại chỗ. *Preview API.* |
| `generate-design` | ✓ | Doc hoặc presentation do AI tạo từ brief và dàn ý. *Preview API; cần `design_generation`, tốn AI credit.* |
| `export-design` | ✓ | pdf, jpg, png, pptx, gif, mp4, html_bundle, html_standalone, csv. `download: true` lưu file về máy. |
| `import-design-from-url` | ✓ | PDF, PPTX, DOCX, Keynote, AI, PSD… từ URL công khai thành thiết kế chỉnh sửa được. |
| `import-design-from-file` | | Như trên, từ file trên máy. |

### Asset (ảnh, video)

| Công cụ | Chính thức | Chức năng |
| --- | --- | --- |
| `upload-asset-from-url` | ✓ | Ảnh/video vào Uploads; trả về asset ID. |
| `upload-asset-from-file` | | Như trên, từ file trên máy. |
| `get-assets` | ✓ | Metadata của tối đa 20 asset. |
| `update-asset` | | Đổi tên hoặc gắn lại tag. |
| `generate-image` | ✓ | Ảnh AI từ prompt, hiện ngay, có thể lưu vào Uploads. *Preview API; cần `image_generation`.* |
| `remove-background` | ✓ | Asset mới đã tách nền. *Preview API; gói trả phí.* |

### Thư mục

| Công cụ | Chính thức | Chức năng |
| --- | --- | --- |
| `create-folder` | ✓ | Trong Projects (`root`), Uploads (`uploads`) hoặc thư mục khác. |
| `list-folder-items` | ✓ | Thư mục, thiết kế, ảnh, brand template. `root` = gốc Projects. |
| `move-item-to-folder` | ✓ | Di chuyển thiết kế, thư mục hoặc ảnh. |

### Bình luận

| Công cụ | Chính thức | Chức năng |
| --- | --- | --- |
| `comment-on-design` | ✓ | Mở luồng bình luận mới, có thể giao cho người khác. *Preview API.* |
| `reply-to-comment` | ✓ | Trả lời một luồng. *Preview API.* |
| `get-comment-thread` | | Đọc một luồng theo ID. *Preview API.* |
| `list-replies` | ✓ | Liệt kê trả lời của một luồng. *Preview API.* |

### Brand template và autofill

| Công cụ | Chính thức | Chức năng |
| --- | --- | --- |
| `search-brand-templates` | ✓ | `dataset: "non_empty"` chỉ trả template có trường autofill. *Gói có brand template.* |
| `get-brand-template-dataset` | ✓ | Các trường dữ liệu của template và kiểu của chúng. |
| `get-design-dataset` | ✓ | Như trên, cho một thiết kế. |
| `autofill-design` | ✓ | Điền trường chữ, ảnh, video, biểu đồ, bảng: tạo thiết kế mới hoặc cập nhật tại chỗ. *Pro, Teams hoặc Enterprise.* |
| `publish-brand-template` | ✓ | Xuất bản thiết kế thành brand template. *Preview API; cần scope `brandtemplate:content:write`.* |

### Sửa trong trang (qua bridge)

| Công cụ | Chức năng |
| --- | --- |
| `editor-status` | Có editor nào đang kết nối không, thiết kế nào (kèm ID) và trang nào đang mở, danh sách trang, và gợi ý bước tiếp theo khi có trục trặc. |
| `read-page` | Phần tử của trang đang mở (hoặc trang *n*): chữ và định dạng, hình chữ nhật, shape, nhóm, embed, vị trí, kích thước, màu, trạng thái khóa. Mỗi phần tử có `path` và `key`. |
| `edit-page` | Một batch tối đa 100 thao tác, tất cả-hoặc-không. Có `dryRun`. |

Các thao tác của `edit-page`:

| Thao tác | Chức năng |
| --- | --- |
| `set_text` | Thay toàn bộ chữ của phần tử chữ (`\n` là đoạn mới). |
| `replace_text` | Thay một phần chữ (lần đầu, hoặc mọi lần với `all: true`), giữ định dạng phần còn lại. |
| `format_text` | Định dạng cả phần tử hoặc một đoạn chữ: màu, độ đậm, nghiêng, gạch chân, gạch ngang, link, cỡ chữ, căn lề, giãn dòng, giãn chữ, danh sách. |
| `transform` | Di chuyển (`top`, `left`), xoay, đổi độ trong suốt. |
| `set_fill` | Đổi màu nền của hình chữ nhật hoặc shape (cả shape hoặc một path). `null` để bỏ màu. |
| `set_stroke` | Đổi màu và độ dày viền. |
| `set_background` | Đổi màu nền trang. |
| `reorder` | Đưa lên trên cùng, xuống dưới cùng, lên một lớp, xuống một lớp. |
| `delete` | Xóa phần tử cấp cao nhất. |
| `group`, `ungroup` | Nhóm và rã nhóm. |
| `insert_text` | Thêm chữ. |
| `insert_rect` | Thêm hình chữ nhật. |
| `insert_shape` | Thêm shape vector từ dữ liệu path SVG (tối đa 30 path). |
| `insert_image` | Upload một ảnh (file trên máy, URL https, hoặc data URL) vào Uploads rồi đặt lên trang, cắt để lấp đầy khung. `radius` tạo khung bo góc. |
| `insert_embed` | Thêm embed (YouTube hoặc URL hỗ trợ oEmbed). |

Phần tử mới luôn được chèn lên **trên cùng** của trang.

### Khác biệt so với Canva MCP chính thức

Server chính thức dùng các API nội bộ của Canva mà Connect API công khai không có. Các công cụ chính thức sau **không có** ở đây:

- Các editing transaction (`start-editing-transaction`, `perform-editing-operations`, `commit-editing-transaction`, `cancel-editing-transaction`). Thay vào đó dùng `read-page`/`edit-page` qua bridge, nhưng cần mở thiết kế trong trình duyệt.
- `get-design-content`, `get-presenter-notes`. Không có endpoint REST cho nội dung thiết kế; `read-page` đọc chữ của trang đang mở.
- `create-design-from-candidate`. Generation công khai tạo thiết kế trực tiếp, không qua bước candidate.
- `list-comments` (API không liệt kê được các luồng; `get-comment-thread` đọc theo ID), `search-folders`, `list-brand-kits`, `create-brand-template-draft`, `separate-image-layers`, `create-upload-url`, `help`.

---

## 6. Giới hạn (limitations)

### Giới hạn của Canva Connect REST API

- **Không sửa được nội dung bên trong thiết kế** qua REST. Mọi chỉnh sửa phần tử phải qua editing bridge.
- **Preview API.** Các công cụ đánh dấu *Preview API* dùng endpoint mà Canva có thể thay đổi mà không ra phiên bản API mới. Canva cũng không cho integration public dùng preview API qua vòng review. Điều này không ảnh hưởng khi bạn chỉ dùng với tài khoản của mình.
- **Tính năng theo gói.** Autofill, brand template, resize, tách nền, AI generation cần gói trả phí hoặc capability tương ứng. Thiếu thì Canva trả 403. `whoami` liệt kê `capabilities` bạn đang có.
- **Rate limit.** Canva giới hạn số lượt gọi. canva-mcp tự thử lại khi gặp 429, nhưng loạt gọi dồn dập vẫn có thể bị từ chối.
- **Xuất file có phần tử premium** mà tài khoản không có bản quyền sẽ lỗi `license_required`.
- **Link `edit_url`/`view_url` là tạm thời** và chỉ dùng được cho người đã đăng nhập; đừng chia sẻ chúng cho người khác.
- **Thumbnail có thể bị cache, hiển thị phiên bản cũ.** Để xem trạng thái thật, dùng `export-design` (jpg, `download: true`).
- **Xuất ngay sau khi sửa** (gọi song song) có thể ra bản trước khi sửa. Xuất trong một lời gọi riêng, sau khi `edit-page` đã trả về.

### Giới hạn của editing bridge (Canva Apps SDK)

- **Cần trình duyệt.** Chỉ chạy trong Chrome hoặc Edge, với thiết kế đang mở và panel app đang mở. Ứng dụng Canva desktop không nạp được app từ `localhost`.
- **Không resize được phần tử có sẵn.** Với chữ, đổi `fontSize`. Với hình và shape, xóa rồi chèn lại.
- **Không thay được ảnh có sẵn**, và không đặt được ảnh làm nền trang. `insert_image` chỉ thêm ảnh mới thành phần tử riêng.
- **Không chọn được font.** `insert_text`/`format_text` không có tùy chọn font family, nên chữ mới dùng font mặc định của Canva. Đổi font bằng tay nếu bộ nhận diện cần.
- **Không có thao tác cấp trang** (thêm, xóa, sắp xếp trang). Dùng `merge-designs` (xem [mục 4](#thêm-xóa-sắp-xếp-trang)).
- **Không sửa được Docs và whiteboard.** Chúng hiện là trang "unsupported".
- **Phần tử và trang bị khóa chỉ đọc được.** Mở khóa trong editor trước.
- **Một số thao tác chỉ áp dụng cho phần tử cấp cao nhất:** `delete`, `reorder`, `group`, `ungroup`. Rã nhóm trước nếu cần xóa một phần tử con.
- **Tối đa 100 thao tác mỗi batch.** Việc lớn hơn thì chia batch, ví dụ xóa ở batch này, chèn ở batch sau.
- **Shape:** tối đa 30 path, 2 KB dữ liệu path, 6 màu nền khác nhau trên mỗi shape. Path phải có một lệnh M ở đầu và phải đóng (Z). Q/T được tự chuyển thành C. Theo mô tả công cụ, không dùng lệnh cung (A); vẽ bo góc bằng đường cong C.
- **Ảnh chèn:** PNG, JPEG, WebP, SVG, HEIC hoặc TIFF; file khoảng 7,5 MB trở xuống (tối đa 10 MB dưới dạng data URL). URL phải là `https://` và kết thúc bằng phần mở rộng của ảnh. `dryRun` không upload nên không đặt ảnh, nhưng vẫn kiểm tra phần còn lại của batch.
- **Key đổi sau mỗi lần lưu**, kể cả khi chỉ đổi định dạng. Đọc lại trang trước các lần sửa có `key`, hoặc bỏ `key`.
- **Path tham chiếu trang trước batch.** Phần tử vừa chèn trong batch chưa thể được nhắm tới cho đến lần đọc sau.
- **Chiều cao chữ vừa chèn** báo là 100 cho đến khi đọc lại trang. Chiều cao thật xuất hiện ở lần đọc/sửa sau.
- **Một phiên chỉnh sửa tại một thời điểm.** Gọi `read-page`/`edit-page` song song sẽ lỗi "a session is already open".
- **`group` rất lớn** (khoảng 70 phần tử) đôi khi báo `internal_error` nhưng vẫn được áp dụng. Đọc lại trang trước khi thử lại.
- **Trang sao chép từ cùng thiết kế** có thể có thứ tự phần tử khác trang gốc, nên `path` khác. Đọc trang bản sao trước khi sửa.
- **Chứng chỉ tự ký** (khi dùng upload bundle) phải được chấp nhận lại mỗi phiên trình duyệt, trừ khi dùng mkcert.
- **Sửa `bridge-app/` cần upload lại bundle** lên Developer Portal (nếu dùng upload bundle). Tải lại panel thôi thì app cũ vẫn chạy.

### Giới hạn của svg2canva

Mỗi mục sau in ra một ghi chú khi gặp:

- **Ảnh** bị bỏ qua; đặt bằng `insert_image` của `edit-page` hoặc bằng tay.
- **Font** dùng font mặc định của Canva.
- **Viền đứt nét** được vẽ liền.
- **Hai cỡ chữ trên cùng một dòng** được vẽ một cỡ.
- **Gradient tròn (radial)** được vẽ bằng màu giữa. Gradient thẳng trên hình chữ nhật được vẽ thành 30 dải màu.
- **Transform khác** ngoài `translate()`, clip path, mask và filter không được chuyển.

---

## 7. Xử lý sự cố

| Triệu chứng | Cách xử lý |
| --- | --- |
| "Not signed in to Canva" | Chạy `npm run login`, hoặc bảo Claude đăng nhập. |
| Trang đăng nhập báo lỗi redirect URL hoặc scope | Redirect URL trong Developer Portal phải bằng `CANVA_REDIRECT_URI`, và mọi scope trong `CANVA_SCOPES` phải được tick trên integration. |
| "Port 3001 is already in use" | Dừng chương trình đang giữ cổng, hoặc đổi cổng ở cả `CANVA_REDIRECT_URI` và Developer Portal. |
| 403 `permission_denied` | Integration thiếu scope cho lời gọi đó, hoặc bạn bật scope sau khi đăng nhập: đăng nhập lại (`login` với `force: true`, hoặc `npm run login`). Tính năng theo gói cũng trả 403 trên gói không có; xem `capabilities` trong `whoami`. |
| Export lỗi `license_required` | Thiết kế có phần tử premium mà tài khoản chưa có bản quyền. |
| "refresh token already used" / không gia hạn được | Có nơi khác đã dùng refresh token (ví dụ bản sao file token trên máy khác). Đăng nhập lại. |
| "Timed out waiting for the token lock" | Nếu không còn tiến trình canva-mcp nào chạy, xóa file `~/.canva-mcp/tokens.json.lock`. |
| "No Canva editor is connected" | Mở thiết kế trong Chrome/Edge và mở panel canva-mcp bridge. Nếu panel báo "Waiting", cho phép truy cập mạng cục bộ ở thanh địa chỉ rồi bấm **Retry now**. |
| Panel báo "couldn't load the app's JavaScript bundle" | App đang nạp từ Development URL mà canva-mcp chưa chạy, hoặc chương trình khác giữ cổng 8080. Khởi động Claude (hoặc `npm run try-bridge`) rồi tải lại panel. Hoặc chuyển sang upload bundle. |
| Panel báo `ws://` "blocked by Content Security Policy" và `wss://` "not reachable" | Đây là bản upload bundle. Nếu Claude đang chạy, trình duyệt chưa chấp nhận chứng chỉ: bấm **Open certificate page**, chọn **Advanced → Continue**. `editor-status` cũng báo số lần bắt tay chứng chỉ bị từ chối. |
| "The bridge app … is an older version" | Bấm biểu tượng tải lại ở đầu panel app. Với upload bundle, upload lại `bridge-app/dist/app.js`. |
| "Port 3860 is in use by a program that isn't a canva-mcp bridge" | Dừng chương trình đang giữ cổng. `editor-status` hiển thị thông báo này. |
| "changed since it was read" | Phần tử đã đổi sau `read-page` (có thể do bạn sửa tay). Đọc lại trang và thử lại. |
| "a session is already open" | Có lời gọi bridge khác đang chạy. Chờ nó xong, đọc lại trang, rồi thử lại. |

---

## 8. Cấu hình

Đặt trong `.env` hoặc biến môi trường.

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET` | — | Thông tin đăng nhập của integration. Bắt buộc. |
| `CANVA_REDIRECT_URI` | `http://127.0.0.1:3001/oauth/redirect` | Địa chỉ callback khi đăng nhập. Phải khớp Developer Portal. |
| `CANVA_SCOPES` | mọi scope đọc/ghi mà công cụ dùng | Danh sách scope (cách nhau bằng dấu cách) xin khi đăng nhập. |
| `CANVA_TOKEN_FILE` | `~/.canva-mcp/tokens.json` | Nơi lưu token. |
| `CANVA_DOWNLOAD_DIR` | `<temp>/canva-mcp-exports` | Nơi `export-design` lưu file khi `download: true`. |
| `CANVA_JOB_TIMEOUT_MS` | `90000` | Thời gian chờ job bất đồng bộ trước khi trả `jobId`. |
| `CANVA_TOOL_PREFIX` | `canva_local_` | Tiền tố tên công cụ; để trống để dùng tên chính thức. |
| `CANVA_NO_BROWSER` | — | `1`: `npm run login` chỉ in URL đăng nhập, không mở trình duyệt. |
| `CANVA_BRIDGE_APP_ORIGIN` | — (mọi `https://app-*.canva-apps.com`) | Origin của bridge app. Chỉ origin này được kết nối. Nên đặt. |
| `CANVA_BRIDGE` | bật | `off` tắt bridge và ba công cụ của nó. |
| `CANVA_BRIDGE_APP_PORT` | `8080` | Cổng phục vụ bundle app; phải khớp Development URL. `0` = không phục vụ. |
| `CANVA_BRIDGE_TLS_PORT` | `3861` | Cổng `wss://` cho upload bundle. Dùng chứng chỉ tự ký trong `~/.canva-mcp/certs`, hoặc `CANVA_BRIDGE_CERT`/`CANVA_BRIDGE_KEY`. `0` = tắt. |
| `CANVA_BRIDGE_TIMEOUT_MS` | `30000` | Thời gian chờ app trả lời. |

Lệnh dòng lệnh: `node dist/index.js login | logout | status`. `logout` thu hồi refresh token với Canva và xóa file token. Không có lệnh thì server chạy MCP qua stdio.

---

## 9. Bảo mật

- **Không commit `.env`.** File này chứa client secret và đã có trong `.gitignore`. Nếu lỡ lộ secret, tạo secret mới trong Developer Portal.
- **Token** nằm ở `~/.canva-mcp/tokens.json`, ngoài thư mục dự án. Ai có file này có thể dùng tài khoản Canva của bạn trong phạm vi scope đã cấp. Lệnh `node dist/index.js logout` thu hồi nó với Canva và xóa file.
- **Bridge** chỉ lắng nghe trên loopback và chỉ nhận origin của app bạn (khi đã đặt `CANVA_BRIDGE_APP_ORIGIN`). Kết nối relay giữa các phiên canva-mcp được xác thực bằng `~/.canva-mcp/bridge-secret`.
- **`edit-page` thay đổi thiết kế thật.** Mọi batch đều hoàn tác được bằng Ctrl+Z trong editor, nhưng nên dùng `dryRun` cho thay đổi lớn và thử trên bản sao khi cần.

---

## 10. Phát triển và kiểm thử

```bash
npm test
```

Bộ test build server rồi chạy trên các bản giả lập cục bộ:

- **REST và OAuth** (`test/mock-canva.mjs`): đăng nhập PKCE, xoay vòng refresh token (kể cả hai tiến trình gia hạn cùng lúc), thử lại khi 401, chờ job và chuyển `get-job`, upload, export có tải về, đặt tên công cụ.
- **Editor** (`test/fake-editor.mjs`): các handler thật của bridge app chạy trên editor giả. Kiểm tra mọi thao tác sửa, batch tất cả-hoặc-không, key cũ, ghim origin, server phục vụ bundle, relay giữa các phiên và tiếp quản, cổng bị chương trình khác giữ.
- **svg2canva** (`test/svg2canva.test.mjs`): ánh xạ trang, thứ tự slide, và chuyển một slide mẫu (`test/svg-sample.mjs`) mà thao tác của nó phải chạy được với `edit-page` trên editor giả.

Cấu trúc thư mục:

```
src/
  index.ts            điểm vào: CLI (login/logout/status) hoặc MCP server qua stdio
  server.ts           đăng ký công cụ và hướng dẫn cho MCP client
  config.ts           đọc .env và biến môi trường
  canva/              OAuth + token (auth.ts), REST client (rest.ts), xử lý ID/link, path shape
  tools/              định nghĩa từng nhóm công cụ MCP
  bridge/             WebSocket server, owner/relay, chứng chỉ tự ký, giao thức
bridge-app/           app Canva chạy trong editor (Apps SDK), build bằng esbuild
scripts/              try-bridge (kiểm tra bridge), svg2canva (SVG → Canva)
test/                 test Node (node --test)
```
