import { Router } from "express";
import { requireAuth, AuthedRequest } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/errorHandler";
import * as notificationsService from "./notifications.service";

const router = Router();
router.use(requireAuth);

// Powers the notification bell — see notifications.service.ts for how each
// entry is derived from existing tables rather than a Notification table.
router.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const notifications = await notificationsService.listNotifications(req.companyId, req.userId);
    res.json({ notifications });
  })
);

export default router;
