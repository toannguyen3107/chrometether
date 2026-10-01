# 🌐 ChromeTether

> **Bộ toolkit duyệt web 2 tầng và điều khiển Chrome trực tiếp cho AI Agent thông qua giao thức MCP (Model Context Protocol).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-orange.svg)](https://modelcontextprotocol.io)

**ChromeTether** mang đến khả năng duyệt web 2 tầng toàn diện cho các AI coding assistant (ZCode, OpenCode, Claude Code, Claude Desktop, Cursor, Windsurf, Cline, dsh, Antigravity):
1. **Tầng 1 (Fast Reader)**: Bóc tách nội dung HTML và chuyển sang Markdown siêu nhanh (~150ms, 0MB RAM) phục vụ đọc tài liệu, blog tĩnh và tìm kiếm thông tin không cần bật trình duyệt.
2. **Tầng 2 (Điều khiển Chrome trực tiếp)**: Kết nối thẳng vào **cửa sổ Google Chrome bạn đang mở** thông qua cờ `--auto-connect` và Chrome DevTools Protocol (CDP). Không mở cửa sổ trình duyệt ảo, giữ nguyên các tab đang mở và toàn bộ phiên đăng nhập của bạn!

---

## 🌟 Kiến trúc & Tính năng cốt lõi

```mermaid
flowchart TD
    User["Your web request"] --> Agent["AI Agent (ZCode, OpenCode, Claude, Cursor)"]
    Agent --> Decision{"Task type?"}
    
    Decision -- "Docs, blogs, GitHub, web search" --> Tier1["Tier 1: Fast Reader (tether-reader)"]
    Tier1 --> Res1["HTTP GET + Cheerio + Turndown\n(~150ms, 0MB RAM Chrome)"]
    
    Decision -- "Dynamic sites, forms, clicks, debugging" --> Tier2["Tier 2: Live Chrome (chrome-devtools)"]
    Tier2 --> Res2["Chrome DevTools Protocol (CDP)\n(Accessibility Tree UID, Screenshots, Network, Console)"]
```

### 1. Kiến trúc 2 tầng tối ưu (Dual-Tier)

| Tầng công cụ | Công cụ | Cơ chế hoạt động | Ưu điểm & Trường hợp sử dụng |
| :--- | :--- | :--- | :--- |
| **Tầng 1: Đọc nhanh (Lightweight)** | `read_url_content`, `search_web` | HTTP GET + Cheerio + Turndown + DuckDuckGo | Đọc tài liệu lập trình, blog, GitHub README, tìm kiếm Google/DuckDuckGo nhanh. Tốn **0MB RAM**, phản hồi chỉ trong **~150ms**. |
| **Tầng 2: Chrome trực tiếp (Live Chrome)** | `chrome-devtools` (`navigate_page`, `click`, `fill`, `take_snapshot`, `take_screenshot`, `list_console_messages`, `list_network_requests`) | Chrome DevTools Protocol chính chủ từ Google | Tương tác Single Page App (React, Next.js, Vue), điền form, click nút, chụp ảnh màn hình, kiểm tra lỗi JavaScript Console & Network API. |

### 2. Bắt sóng Chrome đang mở (`--auto-connect`)
Khác với các công cụ thông thường bật ra một trình duyệt trắng trơn không có cookies:
* Tự động gắn kết (attach) trực tiếp vào cửa sổ Google Chrome bạn đang lướt hàng ngày.
* Tận dụng ngay các tài khoản bạn đã đăng nhập sẵn (GitHub, AWS, Google Cloud, Jira, mạng nội bộ công ty).
* Thao tác trực tiếp trên các tab bạn đang mở trước mắt.

### 3. Tương tác chính xác qua Accessibility Tree `uid`
* Không gây tràn token do nhồi nhét mã HTML thô.
* Dùng cây trợ năng (Accessibility Tree) của Chrome, mỗi phần tử tương tác được đánh số `uid` (ví dụ: `[uid: 10] button "Log in"`).
* AI tương tác chính xác 100%: `fill(14, "email@example.com")` và `click(10)`.

### 4. Bản đồ ứng dụng (`tether-map`)

Trình cài đặt đăng ký thêm MCP server `tether-map`. Khi agent khảo sát ứng dụng trong Chrome, server này lưu các trang đã đi qua và gom request theo phương thức cùng mẫu đường dẫn. Ví dụ, hai request `GET /api/orders/123` và `GET /api/orders/456` được gom thành `GET /api/orders/{id}`. Bản đồ cũng ghi mã trạng thái, **tên** tham số truy vấn và trang nơi request xuất hiện.

Bạn có thể yêu cầu: **“Hãy lập bản đồ các trang và API quan sát được khi khảo sát https://app.example.com.”** Quy trình:

1. Gọi `start_app_map(target_url)`; thêm `allowed_origins` nếu ứng dụng dùng API ở origin riêng.
2. Duyệt bằng `chrome-devtools`, rồi gọi `record_app_page(page_url, title)` cho từng trang đã ghé thăm.
3. Gọi `list_network_requests({includePreservedRequests: true})` để giữ các request qua lần chuyển trang, rồi chuyển URL, phương thức, mã trạng thái và loại tài nguyên sang `record_app_requests(page_url, requests)`. Mỗi lần gọi nhận tối đa 200 request.
4. Gọi `get_app_map({kind: "api"})` để xem các endpoint API. Dùng `page_offset`, `endpoint_offset` và `limit` để phân trang kết quả.

Phiên bản này cần agent chuyển thông tin request sang `tether-map`; server chưa tự chặn hay ghi toàn bộ lưu lượng Chrome. Chỉ các origin được khai báo được ghi nhận. Body, header, cookie, giá trị query và fragment không được lưu. File mặc định là `~/.chrometether/app-map.json`; có thể đổi bằng biến môi trường `CHROMETETHER_MAP_FILE`. Gọi `start_app_map` sẽ thay bản đồ cũ trong file đó.

---

## 🚀 Cài đặt nhanh 1-Click

### Cách 1: PowerShell Script (Windows)
Clone repo về máy và chạy:

```powershell
git clone https://github.com/toannguyen3107/chrometether.git
cd chrometether
npm install
.\scripts\setup.ps1
```

### Cách 2: Lệnh CLI (Đa nền tảng)

```bash
git clone https://github.com/toannguyen3107/chrometether.git
cd chrometether
npm install

# Check installed agents
node bin/chrometether.js status

# Configure all detected agents
node bin/chrometether.js install all

# Or install for a specific agent
node bin/chrometether.js install zcode
node bin/chrometether.js install opencode
node bin/chrometether.js install claude-code
node bin/chrometether.js install claude-desktop
node bin/chrometether.js install cursor
node bin/chrometether.js install windsurf
node bin/chrometether.js install cline
node bin/chrometether.js install dsh
node bin/chrometether.js install antigravity
```

---

## ⚙️ Kích hoạt gỡ lỗi trên Google Chrome (Làm 1 lần)

Để ChromeTether có quyền kết nối vào các tab Chrome đang chạy, hãy bật cổng gỡ lỗi:

### Cách 1 (Khuyên dùng)
1. Mở một tab trên Google Chrome đang dùng.
2. Dán địa chỉ sau vào thanh URL: `chrome://inspect/#remote-debugging`
3. Tích chọn ô: **"Enable remote debugging"** (hoặc "Discover network targets").

### Cách 2 (Khởi động kèm cờ lệnh)
Khởi động Chrome kèm cờ:
```bash
chrome.exe --remote-debugging-port=9222
```

---

## 🤖 Các AI Agent được hỗ trợ

| Agent | File cấu hình | Tính năng được tích hợp |
| :--- | :--- | :--- |
| **ZCode (Z.ai)** | `~/.zcode/cli/config.json` | Đăng ký `chrome-devtools`, `tether-reader` và `tether-map`. Cài lệnh `/browser` cùng bộ browser skills. |
| **OpenCode CLI** | `~/.config/opencode/opencode.jsonc` | Tự động merge theo chuẩn mảng `command` của OpenCode với `--auto-connect`. |
| **Claude Code CLI** | `~/.claude.json` | Cấu hình MCP + tự động sao chép skills vào `~/.claude/skills/`. |
| **Claude Desktop** | `claude_desktop_config.json` | Tự động merge cấu hình stdio MCP. |
| **Cursor IDE** | `~/.cursor/mcp.json` | Cấu hình MCP cho Cursor. |
| **Windsurf (Codeium)** | `~/.codeium/windsurf/mcp_config.json` | Cấu hình MCP cho Cascade. |
| **Roo Code / Cline** | `cline_mcp_settings.json` | Cấu hình MCP cho extension VS Code. |

---

## 🧪 Kiểm tra & Chẩn đoán sức khỏe

Chạy bộ test tích hợp bất cứ lúc nào:
```bash
npm test
```
Bộ test sẽ xác minh:
* Khả năng chuyển đổi HTML sang Markdown của Fast Reader.
* Tìm kiếm DuckDuckGo không cần API key.
* Kết nối JSON-RPC chuẩn MCP của `tether-reader`.
* Kết nối JSON-RPC chuẩn MCP của `tether-map`.
* Khả năng khởi động Stdio MCP của `chrome-devtools`.

Chạy `npm run test-map` để kiểm tra bản đồ ứng dụng không cần mạng và `npm run test-merger` để kiểm tra cấu hình installer.

---

## 🔒 Bảo mật & An toàn

* **Sao lưu tự động**: Trình cài đặt luôn tạo bản sao lưu `.bak` kèm timestamp trước khi chỉnh sửa file cấu hình của bạn, tuyệt đối không làm mất các server MCP sẵn có (như Burp, DB mcp, v.v.).
* **100% Cục bộ**: Toàn bộ giao tiếp MCP chạy qua kênh Stdio cục bộ, không gửi dữ liệu qua bất kỳ máy chủ trung gian nào.
* **Không yêu cầu API Key**: Tìm kiếm nhanh và bóc tách web hoạt động trực tiếp, không đòi hỏi đăng ký token của bên thứ ba.

---

## 📄 Bản quyền

Phát hành theo giấy phép [MIT License](LICENSE) © 2026 Toan Nguyen.
