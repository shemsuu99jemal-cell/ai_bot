import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const outputPath = path.resolve("client-order-flow-guide.pdf");
const fontLatin = path.resolve(
  "node_modules/@fontsource/noto-sans-ethiopic/files/noto-sans-ethiopic-latin-400-normal.woff",
);
const fontAmharic = path.resolve(
  "node_modules/@fontsource/noto-sans-ethiopic/files/noto-sans-ethiopic-ethiopic-400-normal.woff",
);

const colors = {
  ink: "#172033",
  muted: "#637083",
  blue: "#2563eb",
  paleBlue: "#eaf2ff",
  green: "#16a34a",
  paleGreen: "#ecfdf3",
  orange: "#d97706",
  paleOrange: "#fff7ed",
  border: "#d9e1ec",
  screen: "#f4f7fb",
  white: "#ffffff",
};

const doc = new PDFDocument({ size: "A4", margin: 44, bufferPages: true });
doc.pipe(fs.createWriteStream(outputPath));
doc.registerFont("Latin", fontLatin);
doc.registerFont("Amharic", fontAmharic);

type FlowStep = {
  title: string;
  amharicTitle: string;
  screen: string[];
  english: string;
  amharic: string;
  color: string;
};

function text(value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions = {}): void {
  doc.font("Latin").fillColor(colors.ink).text(value, x, y, options);
}

function bilingual(english: string, amharic: string, x: number, y: number, width: number): number {
  doc.font("Latin").fontSize(9).fillColor(colors.ink).text(english, x, y, { width, lineGap: 2 });
  const englishHeight = doc.heightOfString(english, { width, lineGap: 2 });
  doc.font("Amharic").fontSize(9).fillColor(colors.muted).text(amharic, x, y + englishHeight + 4, { width, lineGap: 2 });
  return englishHeight + 4 + doc.heightOfString(amharic, { width, lineGap: 2 });
}

function pageTitle(title: string, subtitle: string): void {
  doc.font("Latin").fontSize(23).fillColor(colors.ink).text(title, 44, 42);
  doc.font("Amharic").fontSize(13).fillColor(colors.muted).text(subtitle, 44, 73);
  doc.moveTo(44, 101).lineTo(551, 101).strokeColor(colors.border).stroke();
}

function arrow(x: number, y: number, label: string): void {
  doc.strokeColor(colors.blue).lineWidth(2).moveTo(x, y).lineTo(x + 38, y).stroke();
  doc.fillColor(colors.blue).polygon([x + 38, y], [x + 29, y - 5], [x + 29, y + 5]).fill();
  doc.font("Latin").fontSize(7).fillColor(colors.blue).text(label, x + 3, y - 16);
}

function phone(x: number, y: number, title: string, lines: string[], accent: string): void {
  const width = 137;
  const height = 226;
  doc.roundedRect(x, y, width, height, 14).fillAndStroke(colors.white, colors.border);
  doc.roundedRect(x + 8, y + 11, width - 16, height - 20, 7).fill(colors.screen);
  doc.roundedRect(x + 8, y + 11, width - 16, 29, 7).fill(accent);
  doc.font("Latin").fontSize(9).fillColor(colors.white).text("Telegram", x + 18, y + 20);
  doc.font("Latin").fontSize(9).fillColor(colors.ink).text(title, x + 17, y + 53, { width: width - 34, align: "center" });
  let lineY = y + 82;
  for (const line of lines) {
    const isButton = line.startsWith("[");
    const clean = line.replace(/^\[|\]$/g, "");
    if (isButton) {
      doc.roundedRect(x + 18, lineY - 3, width - 36, 20, 4).fillAndStroke(colors.paleBlue, "#b9d1ff");
      doc.font("Latin").fontSize(7).fillColor(colors.blue).text(clean, x + 23, lineY + 3, { width: width - 46, align: "center" });
      lineY += 27;
    } else {
      doc.font("Latin").fontSize(7.5).fillColor(colors.ink).text(clean, x + 18, lineY, { width: width - 36, lineGap: 2 });
      lineY += Math.max(20, doc.heightOfString(clean, { width: width - 36, lineGap: 2 }) + 8);
    }
  }
}

function flowPage(title: string, subtitle: string, steps: FlowStep[]): void {
  doc.addPage();
  pageTitle(title, subtitle);
  const startY = 125;
  const cardWidth = 147;
  const gap = 24;
  steps.forEach((step, index) => {
    const x = 44 + index * (cardWidth + gap);
    doc.roundedRect(x, startY, cardWidth, 92, 10).fillAndStroke(colors.white, colors.border);
    doc.circle(x + 22, startY + 24, 13).fill(step.color);
    doc.font("Latin").fontSize(10).fillColor(colors.white).text(String(index + 1), x + 18.5, startY + 20);
    doc.font("Latin").fontSize(11).fillColor(colors.ink).text(step.title, x + 42, startY + 18, { width: cardWidth - 51 });
    doc.font("Amharic").fontSize(8).fillColor(colors.muted).text(step.amharicTitle, x + 17, startY + 45, { width: cardWidth - 34 });
    doc.font("Latin").fontSize(7).fillColor(colors.muted).text("Follow this step", x + 17, startY + 68);
    if (index < steps.length - 1) arrow(x + cardWidth + 3, startY + 46, "NEXT");
  });

  let y = 245;
  steps.forEach((step, index) => {
    doc.font("Latin").fontSize(11).fillColor(step.color).text(`${index + 1}. ${step.title}`, 44, y);
    y += 18;
    y += bilingual(step.english, step.amharic, 57, y, 494) + 16;
  });
}

// Cover page.
doc.roundedRect(44, 48, 507, 690, 18).fill(colors.ink);
doc.font("Latin").fontSize(31).fillColor(colors.white).text("Order Flow Guide", 78, 120, { width: 440 });
doc.font("Amharic").fontSize(19).fillColor("#c8d8f5").text("የትዕዛዝ አሰራር መመሪያ", 78, 170, { width: 440 });
doc.font("Latin").fontSize(13).fillColor("#c8d8f5").text("A visual guide for customers and sellers", 78, 222);
doc.font("Amharic").fontSize(12).fillColor("#c8d8f5").text("ለደንበኞችና ለሻጮች የምስል መመሪያ", 78, 247);
doc.roundedRect(78, 335, 185, 175, 12).fillAndStroke("#1e2b44", "#50678e");
doc.font("Latin").fontSize(15).fillColor(colors.white).text("CUSTOMER", 99, 360);
doc.font("Amharic").fontSize(11).fillColor("#c8d8f5").text("ደንበኛ", 99, 384);
doc.font("Latin").fontSize(10).fillColor("#c8d8f5").text("Browse → Cart → Checkout → Pay → Send receipt", 99, 425, { width: 145, lineGap: 5 });
arrow(270, 420, "FOLLOW");
doc.roundedRect(315, 335, 185, 175, 12).fillAndStroke("#1e2b44", "#50678e");
doc.font("Latin").fontSize(15).fillColor(colors.white).text("ADMIN", 336, 360);
doc.font("Amharic").fontSize(11).fillColor("#c8d8f5").text("አስተዳዳሪ", 336, 384);
doc.font("Latin").fontSize(10).fillColor("#c8d8f5").text("Open dashboard → Check → Confirm/Reject → Deliver", 336, 425, { width: 145, lineGap: 5 });
doc.font("Latin").fontSize(10).fillColor("#c8d8f5").text("English + Amharic", 78, 680);
doc.font("Amharic").fontSize(10).fillColor("#c8d8f5").text("እንግሊዝኛ + አማርኛ", 78, 700);

flowPage("Admin dashboard entry", "ወደ አስተዳዳሪ ዳሽቦርድ የመግቢያ ሂደት", [
  { title: "Open admin", amharicTitle: "አስተዳዳሪ ይክፈቱ", screen: ["Seller account", "Type /admin", "[Open dashboard]"], english: "The seller opens the bot with the seller account and types /admin, or taps Menu to reach the seller controls.", amharic: "ሻጩ በሻጭ መለያ ቦቱን ከፍቶ /admin ይጽፋል፤ ወይም ሜኑን በመጫን የሻጭ መቆጣጠሪያዎችን ይደርሳል።", color: colors.blue },
  { title: "Dashboard", amharicTitle: "ዳሽቦርድ", screen: ["Seller Dashboard", "[Products]", "[Orders]", "[Payments]"], english: "The dashboard is the main control screen. Use it to manage products, orders, payment accounts, and help.", amharic: "ዳሽቦርዱ ዋናው የመቆጣጠሪያ ገጽ ነው። ምርቶችን፣ ትዕዛዞችን፣ የክፍያ መለያዎችንና እርዳታን ከዚህ ያስተዳድሩ።", color: colors.green },
  { title: "Choose task", amharicTitle: "ስራ ይምረጡ", screen: ["[Add Product]", "[Orders]", "[Payments]", "[Help]"], english: "Choose the task you need. Products handles catalog changes, Orders handles customers, and Payments handles accounts.", amharic: "የሚፈልጉትን ስራ ይምረጡ። ምርቶች የምርት ለውጥን፣ ትዕዛዞች ደንበኞችን፣ ክፍያዎች መለያዎችን ያስተዳድራሉ።", color: colors.orange },
  { title: "Return home", amharicTitle: "ወደ መነሻ ይመለሱ", screen: ["Finish task", "[Dashboard]", "[Refresh]", "[Menu]"], english: "After finishing a task, tap Dashboard, Refresh, or Menu to return and choose the next task.", amharic: "ስራውን ከጨረሱ በኋላ ዳሽቦርድ፣ ሪፍሬሽ ወይም ሜኑን በመጫን ይመለሱና ቀጣዩን ስራ ይምረጡ።", color: colors.blue },
]);

flowPage("Admin product management", "አስተዳዳሪው ምርት የሚያስተዳድርበት ሙሉ ሂደት", [
  { title: "Add", amharicTitle: "ምርት ይጨምሩ", screen: ["Name", "Price + category", "Description + image", "[Save]"], english: "Open Products, tap Add Product, then answer each question in order: name, price, category, description, and image. Send /skip only when an image is not available. Review the summary before saving.", amharic: "ምርቶችን ክፍተው ምርት ጨምርን ይጫኑ። በተራ ስም፣ ዋጋ፣ ምድብ፣ መግለጫና ምስል ያስገቡ። ምስል ከሌለ /skip ይጻፉ። ከማስቀመጥ በፊት ማጠቃለያውን ይመልከቱ።", color: colors.green },
  { title: "Edit", amharicTitle: "ምርት ያስተካክሉ", screen: ["Open product", "[Name] [Price]", "[Description] [Image]", "[Save]"], english: "Open Products, select an existing item, and choose the exact field to change. Update only the incorrect detail, save it, then check the product list again.", amharic: "ምርቶችን ክፍተው ያለ ምርት ይምረጡ። የሚቀየረውን መረጃ ብቻ ይምረጡ፣ ያስተካክሉና ያስቀምጡ። ከዚያ በምርት ዝርዝር ያረጋግጡ።", color: colors.orange },
  { title: "Delete", amharicTitle: "ምርት ይሰርዙ", screen: ["Open product", "Check item", "[Delete]", "[Confirm]"], english: "Open the product, confirm that it is the correct item, choose Delete Product, and confirm. Deletion removes it from the customer catalog.", amharic: "ምርቱን ክፍተው ትክክለኛው ምርት መሆኑን ያረጋግጡ። ምርት ሰርዝን ይምረጡና ያረጋግጡ። ከዚያ ምርቱ ከደንበኛ ዝርዝር ይወገዳል።", color: colors.orange },
  { title: "Check", amharicTitle: "ለውጥ ያረጋግጡ", screen: ["Product list", "Correct price", "Correct image", "Visible to customer"], english: "After adding, editing, or deleting, return to the product list. Confirm the name, price, category, description, and image are correct before customers order.", amharic: "ከመጨመር፣ ከማስተካከል ወይም ከመሰረዝ በኋላ ወደ ምርት ዝርዝር ይመለሱ። ስም፣ ዋጋ፣ ምድብ፣ መግለጫና ምስል ትክክል መሆኑን ያረጋግጡ።", color: colors.blue },
]);

flowPage("1. Customer places an order", "ደንበኛው ትዕዛዝ የሚያስገባበት ሂደት", [
  { title: "Browse", amharicTitle: "ምርት ይፈልጉ", screen: ["Choose category", "[View products]", "[Open product]"], english: "The customer starts the bot, chooses a category, and opens the product they want.", amharic: "ደንበኛው ቦቱን ከፍቶ ምድብ ይመርጣል፤ ከዚያ የሚፈልገውን ምርት ይከፍታል።", color: colors.blue },
  { title: "Cart", amharicTitle: "ወደ ጋሪ ይጨምሩ", screen: ["Product details", "Price + description", "[Add to cart]", "[My cart]"], english: "The customer checks the price and description, selects the quantity, and adds the item to the cart.", amharic: "ደንበኛው ዋጋና መግለጫውን ያያል፣ ብዛቱን ይመርጣልና ወደ ጋሪ ይጨምራል።", color: colors.orange },
  { title: "Checkout", amharicTitle: "ትዕዛዝ ይላኩ", screen: ["Cart total", "Customer details", "[Checkout]", "Order created"], english: "The customer reviews the cart total and checks out. The order is created as awaiting payment.", amharic: "ደንበኛው የጋሪውን ጠቅላላ ዋጋ ያረጋግጥና ይከፍላል። ትዕዛዙ ክፍያ በመጠበቅ ላይ ተብሎ ይፈጠራል።", color: colors.green },
]);

flowPage("2. Payment and verification", "የክፍያና የማረጋገጫ ሂደት", [
  { title: "Payment", amharicTitle: "ክፍያ ይፈጽሙ", screen: ["Order total", "Payment account", "[Pay order]", "Send receipt"], english: "The customer opens My Orders, taps Pay, uses the shown account, and sends a payment screenshot.", amharic: "ደንበኛው የእኔ ትዕዛዞችን ከፍቶ ክፍያን ይጫናል፣ በተሰጠው መለያ ይከፍላልና የክፍያ ስክሪንሾት ይልካል።", color: colors.orange },
  { title: "Admin review", amharicTitle: "አስተዳዳሪ ይመርምር", screen: ["New payment", "Order + receipt", "[Verify]", "[Reject]"], english: "The seller checks the receipt, amount, customer, and order before accepting or rejecting payment.", amharic: "ሻጩ ደረሰኙን፣ መጠኑን፣ ደንበኛውንና ትዕዛዙን ካረጋገጠ በኋላ ይቀበላል ወይም ይከለክላል።", color: colors.blue },
  { title: "Customer status", amharicTitle: "ደንበኛው ሁኔታ ይወቅ", screen: ["Order status", "Pending / Confirmed", "[My orders]", "Contact seller"], english: "The customer can check the order status. Confirmed orders move to preparation and delivery.", amharic: "ደንበኛው የትዕዛዙን ሁኔታ ያያል። የተረጋገጠ ትዕዛዝ ለዝግጅትና ለማቅረብ ይሄዳል።", color: colors.green },
]);

flowPage("Admin order checking", "አስተዳዳሪው ትዕዛዝ የሚመረምርበት ሙሉ ሂደት", [
  { title: "Open order", amharicTitle: "ትዕዛዝ ይክፈቱ", screen: ["[Orders]", "New request", "Customer name", "Phone + date"], english: "Open Orders from the dashboard. Select the new order and read the customer name, phone number, date, items, quantities, total, and current status.", amharic: "ከዳሽቦርድ ትዕዛዞችን ይክፈቱ። አዲሱን ትዕዛዝ ይምረጡና ስም፣ ስልክ፣ ቀን፣ እቃዎች፣ ብዛት፣ ጠቅላላ ዋጋና ሁኔታ ያንብቡ።", color: colors.blue },
  { title: "Check payment", amharicTitle: "ክፍያ ያረጋግጡ", screen: ["Receipt image", "Amount", "Account", "Customer match"], english: "Open the payment receipt sent by the customer. Compare the paid amount, account, order total, and customer information. Do not confirm an unclear or mismatched receipt.", amharic: "ደንበኛው የላከውን የክፍያ ደረሰኝ ይክፈቱ። የተከፈለውን መጠን፣ መለያ፣ የትዕዛዙን ዋጋና የደንበኛ መረጃ ያነጻጽሩ። ግልጽ ያልሆነ ደረሰኝ አያረጋግጡ።", color: colors.orange },
  { title: "Confirm or reject", amharicTitle: "ያረጋግጡ ወይም ይከልክሉ", screen: ["Valid payment", "[Confirm]", "Invalid payment", "[Reject]"], english: "Confirm only when the payment and order are correct. Reject when the receipt is missing, wrong, duplicated, or the item cannot be supplied. Add a clear reason when rejecting.", amharic: "ክፍያውና ትዕዛዙ ትክክል ሲሆኑ ብቻ ያረጋግጡ። ደረሰኝ ከሌለ፣ የተሳሳተ ከሆነ፣ ተደጋግሞ ከተላከ ወይም ምርቱ ከሌለ ይከልክሉ። ሲከለክሉ ግልጽ ምክንያት ይስጡ።", color: colors.green },
  { title: "Prepare and deliver", amharicTitle: "ያዘጋጁና ያቅርቡ", screen: ["Confirmed order", "Prepare items", "Contact customer", "[Deliver]"], english: "For a confirmed order, prepare the exact items and quantities, contact the customer if needed, and deliver using the agreed details.", amharic: "ለተረጋገጠ ትዕዛዝ ትክክለኛውን እቃና ብዛት ያዘጋጁ። ካስፈለገ ደንበኛውን ያነጋግሩና በተስማማችሁበት መረጃ ያቅርቡ።", color: colors.blue },
]);

flowPage("3. Seller daily management", "የሻጭ ዕለታዊ አስተዳደር", [
  { title: "Products", amharicTitle: "ምርቶች", screen: ["[Add product]", "Name + price", "Description + image", "[Save]"], english: "Add products with complete information. Open an existing product to edit or delete it.", amharic: "ምርቶችን ሙሉ መረጃ ጋር ይጨምሩ። ያለ ምርት ለማስተካከል ወይም ለመሰረዝ ይክፈቱት።", color: colors.blue },
  { title: "Orders", amharicTitle: "ትዕዛዞች", screen: ["[Orders]", "Check customer", "Check total", "[Confirm / Reject]"], english: "Open Orders, check every detail, then confirm when you can fulfill the request or reject when necessary.", amharic: "ትዕዛዞችን ክፍተው ሁሉንም መረጃ ያረጋግጡ። ማቅረብ ከቻሉ ያረጋግጡ፤ ካልቻሉ ይከልክሉ።", color: colors.green },
  { title: "Payments", amharicTitle: "ክፍያዎች", screen: ["[Payments]", "Account name", "Account number", "[Save / Deactivate]"], english: "Keep payment account information correct and keep at least one active option for customers.", amharic: "የክፍያ መለያ መረጃ ትክክል ይሁን። ለደንበኞች ቢያንስ አንድ ንቁ አማራጭ ያስቀምጡ።", color: colors.orange },
]);

// Add page numbers.
const range = doc.bufferedPageRange();
for (let index = range.start; index < range.start + range.count; index += 1) {
  doc.switchToPage(index);
  doc.font("Latin").fontSize(8).fillColor(colors.muted).text(`pixelSupplements  •  ${index + 1} / ${range.count}`, 44, 790, { align: "center", width: 507 });
}

doc.end();
console.log(`Created ${outputPath}`);
