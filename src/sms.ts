// SMS escalation — sends a text to the seller's phone when Telegram reminders
// go unanswered. Not wired to a live provider yet; fill in sendSms() once you
// sign up with an Ethiopia-covering SMS gateway.
//
// Recommended: SMSEthiopia (smsethiopia.com) — INSA-licensed, direct Ethio
// Telecom integration, free trial to start. Get your API key and exact
// request format from their dashboard/docs, then fill in below.
// (Twilio / Africa's Talking do NOT reliably cover Ethiopian numbers.)

export async function sendSms(toPhoneNumber: string, message: string): Promise<void> {
  if (!process.env.SMS_API_KEY) {
    console.log(`[SMS not configured] Would send to ${toPhoneNumber}: "${message}"`);
    return;
  }

  // Example shape — REPLACE with SMSEthiopia's actual endpoint/payload from their docs:
  //
  // await fetch('https://api.smsethiopia.com/v1/send', {
  //   method: 'POST',
  //   headers: {
  //     Authorization: `Bearer ${process.env.SMS_API_KEY}`,
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify({ to: toPhoneNumber, message }),
  // });

  console.log(`[SMS placeholder — provider not wired] Would send to ${toPhoneNumber}: "${message}"`);
}
