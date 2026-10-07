# Thiết kế: Trang chủ phim (CIN1, ADR-033)

Đây là nguồn của canvas thiết kế. Bản dựng xem được nằm trên canvas riêng của user trên claude.ai. Mỗi file là một artboard `.dc.html`:

- **Bố cục:** HTML với style inline. Style inline chính là đặc tả: màu, cỡ chữ, khoảng cách, bo góc.
- **`<helmet><style>`:** chứa hover, focus và chuyển động.
- **Lặp và dữ liệu mẫu:** `<sc-for>` dùng để lặp. Dữ liệu mẫu nằm trong `renderVals()`. Dữ liệu thật lấy theo brief.
- **Ô có dạng `[…]`:** đó là chỗ trống cho dữ liệu thật, không phải chữ cần hiển thị.

| File | Nội dung |
|---|---|
| `Main.dc.html` | Trang chủ desktop 1440: thanh trên trong suốt, banner, các hàng (Xem tiếp, Top 10, Dành cho bạn với thẻ hover, Mới cập nhật, khối biên tập, Từ kênh bạn theo dõi), chân trang |
| `Detail.dc.html` | Hộp chi tiết `?v=<id>`: backdrop, nút, mô tả, thông tin, lưới "Tương tự" |
| `Mobile.dc.html` | Trang chủ 390 px: thẻ banner, chip lọc nhanh, hàng 2,2 thẻ, thanh tab dưới đáy |
| `States.dc.html` | Trạng thái thẻ (mặc định, hover, focus, xem tiếp, skeleton) và token màu, chữ, khoảng cách, chuyển động |
