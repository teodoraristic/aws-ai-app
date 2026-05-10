#!/usr/bin/env node
"use strict";

const cdk = require("aws-cdk-lib/core");
const { UniConsultationsStack } = require("../lib/uni-consultations-stack");

const app = new cdk.App();

new UniConsultationsStack(app, "UniConsultationsStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
