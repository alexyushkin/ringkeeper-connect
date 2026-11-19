# Changelog

What's new in each version of Ringkeeper Connect, in plain words. A release's page on GitHub
shows its section under "What's new". Versions before 0.2.0-beta.16 are described on their
[release pages](https://github.com/alexyushkin/ringkeeper-connect/releases).

## 0.2.0-beta.16

- **Meta Ads with an access token.** Add a tool > Meta Ads > **Use an access token**
  (recommended): paste a token you already have, with no Meta app and no sign-in. A System User
  token from Meta Business Settings is best, because it doesn't run out. The AI can read ad
  accounts, campaigns, ad sets, ads and reports (date ranges, breakdowns by age, platform and
  more, per day, week or month). If you tick it, it can also pause campaigns, ad sets and ads,
  and Ringkeeper Connect asks you first, every time, in an Allow / Don't allow window. It can't
  create ads or change budgets.
- **Test connection** for the token: "Works: 3 ad accounts", or what to fix. A token Meta turns
  away isn't added.
- **A week's warning** before a personal Meta token runs out, on the tool's card. Edit takes a
  new token.
- **Google Ads in the Google account.** Two new tick boxes: **Google Ads: reports** (any report,
  with every page of it, and ad accounts under a manager account) and **Google Ads: pause
  campaigns** (asks you first, every time). If Google hasn't approved the Google app for live ad
  accounts yet, it says so and how to apply.
- **Ticking something new on a Google account** (Edit) signs in once more for just that, and
  Google keeps what you'd already allowed.
