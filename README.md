# Futures Scan

اسکن هوشمند ارزها در فیوچرز

## محدوده فعلی

این مرحله فقط جمع‌آوری داده بازار و محاسبه اندیکاتورهاست؛ هیچ شرط لانگ یا شورت، سیگنال یا امتیاز معاملاتی اجرا نمی‌شود.

فیلتر ورود به فهرست نمادها قبل از دریافت تاریخچه اعمال می‌شود:
1. دارایی پایه نباید استیبل‌کوین باشد.
2. آخرین قیمت معامله قرارداد باید حداکثر ۳۰ دلار باشد؛ دقیقاً ۳۰ دلار پذیرفته می‌شود.

## وضعیت پیاده‌سازی فعلی

- **صرافی‌های متصل در کد:** OKX و MEXC.
- **۷ صرافی کاندید پروژه:** MEXC، BingX، OKX، WEEX، HTX، KuCoin و XT؛ پنج مورد از این فهرست هنوز آداپتر اجرایی ندارند و تأیید نشده‌اند.
- **تایم‌فریم‌های تعریف‌شده:** 5m، 15m، 1h، 2h، 4h و 1d.
- **تاریخچه موردنیاز:** ۱۲۰۱ کندل بسته برای محاسبه CCI(1200) و VWAP(1200) و EMA(500).
- **اندیکاتورها:** EMA9، EMA21، EMA500، CCI(1200) و VWAP روزانه با ریست ساعت ۰۰:۰۰ UTC؛ مقدارها و زمان کندل مرجع برای هر تایم‌فریم جداگانه گزارش می‌شود.
- **کیفیت داده:** اعتبارسنجی OHLCV، مرتب‌سازی زمانی، حذف زمان‌های تکراری، کنارگذاشتن کندل باز، کنترل قدیمی‌بودن آخرین کندل و گزارش خطا به‌ازای هر تایم‌فریم.
- **ذخیره‌سازی:** ماژول اختیاری Neon اضافه شده است. تا زمانی که متغیر محیطی DATABASE_URL در محیط اجرا تنظیم نشود، ذخیره‌سازی انجام نمی‌شود.
- **آزمون خودکار:** تست‌های Node.js و workflow برای اجرای تست در GitHub Actions اضافه شده‌اند؛ موفقیت اجرای workflow باید از نتیجه واقعی Actions تأیید شود.

## اجرای تست‌ها

```bash
npm install
npm test
```

## اجرای دریافت داده

```bash
npm run scan
```

متغیرهای اختیاری:
- `EXCHANGES=OKX,MEXC`
- `CONCURRENCY=3` (محدوده مجاز ۱ تا ۱۰)
- `MAX_SYMBOLS=0` (صفر یعنی بدون سقف؛ محدودیت فقط برای تست و پس از فیلترها)
- `SYMBOLS=BTC-USDT-SWAP,BTC_USDT` (فقط برای تست نمادهای مشخص)
- `DATABASE_URL` (اتصال Neon؛ در صورت نبود، ذخیره‌سازی با وضعیت SKIPPED گزارش می‌شود)
- `REQUIRE_DATA=true` (در صورت وجود داده ناقص/خطا، اجرای اسکن با exit code غیرصفر تمام می‌شود)

## فایل‌های اصلی

- `scripts/market-data.mjs`: دریافت و نرمال‌سازی کندل‌های OKX و MEXC
- `scripts/indicators.mjs`: EMA، CCI و VWAP
- `scripts/entry-filters.mjs`: فیلترهای قطعی ورود نماد
- `scripts/scan-long.mjs`: نام فایل برای حفظ سازگاری workflow نگه داشته شده؛ اکنون فقط داده و اندیکاتورها را جمع‌آوری می‌کند.
- `scripts/persist-neon.mjs`: ذخیره snapshot در Neon
- `database/schema.sql`: ساختار جدول snapshot
- `scripts/test-entry-filters.mjs` و `scripts/test-indicators.mjs`: تست‌های واحد

## محدودیت‌های باقی‌مانده

- پیاده‌سازی و آزمون واقعی APIهای BingX، WEEX، HTX، KuCoin و XT هنوز انجام نشده است؛ هیچ‌کدام را تأییدشده تلقی نکن.
- دسترسی زنده و مقایسه مقادیر اندیکاتورها با TradingView هنوز انجام نشده است.
- اتصال Neon در محیط اجرا با DATABASE_URL هنوز پیکربندی و آزمون نشده است.
- رابط کاربری وب و انتخابگر تایم‌فریم‌ها هنوز ساخته نشده‌اند.


## 5m timeframe coverage

The 5m timeframe is an independent market-data timeframe; it does not add or alter any long/short entry condition.

- OKX uses the native `5m` candle interval.
- MEXC USDT perpetual contracts use the documented `Min5` interval.
- The scanner requests two extra candles, removes any still-forming candle, then selects exactly 1,201 closed candles.
- Before calculating indicators, the 5m history must pass timestamp alignment and strict 5-minute continuity checks. Missing, duplicated, overlapping, misaligned, or unclosed candles cause that symbol/timeframe to be reported as `DATA_ERROR`; the scanner does not silently calculate from a broken series.
- EMA9, EMA21, EMA500, CCI(1200), and session VWAP are calculated from that verified history. These are data outputs only; no new trade signal or direction rule is added.

Run the automated structural tests:

```bash
npm test
```

Run the live 5m API check for BTC USDT perpetual on the two currently implemented adapters:

```bash
npm run test:5m:live
```

The live check needs outbound access to both exchange APIs. A PASS means that exchange returned 1,201 closed, continuous 5m candles and the indicator calculations returned finite values at the time of the test; it does not certify the other five candidate exchanges.
