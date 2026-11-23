export interface WiseActivity {
  id: string;
  type: string; // CARD_PAYMENT | TRANSFER | BALANCE_CASHBACK | CARD_CHECK
  resource: { type: string; id: string };
  title: string;        // may contain HTML e.g. "<strong>Brevo</strong>"
  description: string;  // e.g. "Spent by Mari-Annina Oksala" or "Sent by ..."
  primaryAmount: string; // "45 EUR" or "<positive>+ 5,000 EUR</positive>" for credits
  secondaryAmount: string; // "65.74 EUR" for cross-currency debits
  status: string;
  createdOn: string;
  updatedOn: string;
}

export interface WiseActivitiesPage {
  cursor: string | null;
  activities: WiseActivity[];
}

export class WiseClient {
  private readonly token: string;
  private readonly baseUrl = "https://api.transferwise.com";

  constructor() {
    const t = process.env.WISE_API_TOKEN;
    if (!t) throw new Error("WISE_API_TOKEN not set in .env");
    this.token = t;
  }

  async getActivities(
    profileId: number,
    since: string,
    until: string,
    cursor?: string
  ): Promise<WiseActivitiesPage> {
    const params = new URLSearchParams({ size: "100", since, until });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(
      `${this.baseUrl}/v1/profiles/${profileId}/activities?${params}`,
      { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" } }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Wise API /activities → ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { cursor?: string; activities?: WiseActivity[] };
    return {
      cursor: data.cursor ?? null,
      activities: data.activities ?? [],
    };
  }
}
