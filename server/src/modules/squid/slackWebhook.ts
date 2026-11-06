export interface SlackChangeSummary {
  proxyName: string;
  changeType: 'allow' | 'deny' | 'extend' | 'full-net' | 'lock-net' | 'configure';
  target: string;
  ip: string;
  details: string;
  changedBy: string;
  timestamp: string;
}

// Send a message to Slack via incoming webhook
export async function sendSlackWebhook(
  webhookUrl: string,
  title: string,
  details: string,
  options: {
    username?: string;
    icon_emoji?: string;
  } = {}
): Promise<void> {
  if (!webhookUrl) {
    console.warn("Slack webhook URL not configured — skipping notification");
    return;
  }

  const payload = {
    text: `[${title}] ${details}`,
    username: options.username,
    icon_emoji: options.icon_emoji,
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Slack webhook error (${response.status}): ${errorText}`);
    } else {
      console.log(`Slack webhook sent: ${title}`);
    }
  } catch (error) {
    console.error(`Failed to send Slack webhook for ${title}:`, error);
  }
}

// Send a formatted block message to Slack
export async function sendSlackWebhookBlocks(
  webhookUrl: string,
  title: string,
  text: string,
  options: {
    username?: string;
    icon_emoji?: string;
  } = {}
): Promise<void> {
  if (!webhookUrl) {
    console.warn("Slack webhook URL not configured — skipping notification");
    return;
  }

  const payload = {
    text: title,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: title,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: text,
        },
      },
    ],
    username: options.username,
    icon_emoji: options.icon_emoji,
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Slack webhook blocks error (${response.status}): ${errorText}`);
    } else {
      console.log(`Slack webhook blocks sent: ${title}`);
    }
  } catch (error) {
    console.error(`Failed to send Slack webhook blocks for ${title}:`, error);
  }
}

export interface SlackChangeSummary {
  proxyName: string;
  changeType: 'allow' | 'deny' | 'extend' | 'full-net' | 'lock-net' | 'configure';
  target: string;
  ip: string;
  details: string;
  changedBy: string;
  timestamp: string;
}

// Convenience function for posting proxy configuration change notifications
export async function postProxyChangeNotification(
  webhookUrl: string,
  summary: SlackChangeSummary
): Promise<void> {
  if (!webhookUrl) {
    console.warn("Slack webhook URL not configured — skipping notification");
    return;
  }

  const emoji = summary.changeType === 'allow' ? '✅' : summary.changeType === 'deny' ? '🚫' :
                summary.changeType === 'extend' ? '⏱️' : summary.changeType === 'full-net' ? '🔓' :
                summary.changeType === 'lock-net' ? '🔒' : '🔧';

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} Squid Proxy Change`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Proxy:* \`${summary.proxyName}\``,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Type:* ${summary.changeType}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Target:* \`${summary.target}\``,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*IP:* \`${summary.ip}\``,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Details:* ${summary.details}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Changed by:* ${summary.changedBy}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Timestamp:* ${summary.timestamp}`,
      },
    },
  ];

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ blocks }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Slack webhook blocks error (${response.status}): ${errorText}`);
    } else {
      console.log(`Slack webhook blocks sent: Proxy change for ${summary.proxyName}`);
    }
  } catch (error) {
    console.error(`Failed to send Slack webhook for proxy change:`, error);
  }
}