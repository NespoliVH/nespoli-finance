import type { PrismaClient } from "../db.js";
import type { NewAlert } from "./evaluate.js";

// Notificação dos alertas novos (RF24).
//
// O envio pelo APNs (serviço de push da Apple) depende da conta paga do Apple
// Developer, que ainda não existe. Por isso o envio fica atrás da interface
// PushSender: hoje não há remetente e nada sai; quando a conta existir, entra
// uma implementação com o APNs e o resto não muda.
//
// A notificação aparece na tela bloqueada, onde qualquer pessoa por perto lê.
// Por isso ela esconde os valores por padrão, e o usuário escolhe mostrar
// (decisão de 17/11/2026, campo show_amounts_in_push do aparelho).

export interface PushMessage {
  title: string;
  body: string;
  /** Vai para o app, que abre a tela do alerta. Nunca leva valores. */
  data: { alertId: string };
}

export interface PushSender {
  send(apnsToken: string, message: PushMessage): Promise<void>;
}

/** R$ 1.234,56, sem depender do Intl (que usa espaço especial entre R$ e o número). */
export function formatBRL(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

export function alertPushMessage(alert: NewAlert, showAmounts: boolean): PushMessage {
  const pct = Math.round(alert.increasePct);
  return {
    title: "Gasto acima do normal",
    body: showAmounts
      ? `${alert.categoryName}: ${formatBRL(alert.currentCents)} este mês, ${pct}% acima da sua média (${formatBRL(alert.averageCents)}).`
      : `Seus gastos com ${alert.categoryName} este mês estão acima da sua média. Toque para ver.`,
    data: { alertId: alert.id },
  };
}

/** Manda cada alerta novo para todos os aparelhos do usuário. Falha num aparelho não impede os outros. */
export async function notifyAlerts(
  prisma: PrismaClient,
  sender: PushSender | null,
  alerts: readonly NewAlert[],
): Promise<number> {
  if (!sender || alerts.length === 0) return 0;
  const userIds = [...new Set(alerts.map((a) => a.userId))];
  const devices = await prisma.device.findMany({ where: { userId: { in: userIds } } });
  let sent = 0;
  for (const alert of alerts) {
    for (const device of devices.filter((d) => d.userId === alert.userId)) {
      try {
        await sender.send(device.apnsToken, alertPushMessage(alert, device.showAmountsInPush));
        sent++;
      } catch {
        // O alerta continua na tela de alertas; perder um push não perde o aviso.
      }
    }
  }
  return sent;
}
