/// <reference types="@fastly/js-compute" />

import { Router } from "@fastly/expressly"

const router = new Router();

router.get("/", async (_req, res) => {
  return res.send("Hello world!");
});

router.listen();
