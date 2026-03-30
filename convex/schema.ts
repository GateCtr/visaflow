import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const logEntry = v.object({
  msg: v.string(),
  time: v.number(),
  author: v.optional(v.string()),
});

const priceDetails = v.object({
  engagementFee: v.number(),
  successFee: v.number(),
  paidAmount: v.number(),
  isEngagementPaid: v.boolean(),
  isSuccessFeePaid: v.boolean(),
});

const appointmentDetails = v.object({
  date: v.string(),
  time: v.optional(v.string()),
  location: v.optional(v.string()),
  confirmationCode: v.optional(v.string()),
  notes: v.optional(v.string()),
});

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    role: v.string(),
    createdAt: v.number(),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"]),

  applications: defineTable({
    userId: v.string(),
    userFirstName: v.optional(v.string()),
    userLastName: v.optional(v.string()),
    userEmail: v.optional(v.string()),
    userPhone: v.optional(v.string()),
    destination: v.string(),
    visaType: v.string(),
    applicantName: v.string(),
    passportNumber: v.optional(v.string()),
    travelDate: v.string(),
    returnDate: v.optional(v.string()),
    purpose: v.string(),
    notes: v.optional(v.string()),
    status: v.string(),
    appointmentDate: v.optional(v.string()),
    adminNotes: v.optional(v.string()),
    price: v.optional(v.number()),
    isPaid: v.boolean(),
    updatedAt: v.number(),
    priceDetails: v.optional(priceDetails),
    logs: v.optional(v.array(logEntry)),
    paymentProofUrl: v.optional(v.string()),
    successFeeProofUrl: v.optional(v.string()),
    appointmentDetails: v.optional(appointmentDetails),
    rejectionReason: v.optional(v.string()),
    slotExpiresAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"])
    .index("by_updated", ["updatedAt"]),

  messages: defineTable({
    applicationId: v.id("applications"),
    senderId: v.string(),
    senderName: v.string(),
    content: v.string(),
    isFromAdmin: v.boolean(),
    readBy: v.optional(v.array(v.string())),
  }).index("by_application", ["applicationId"]),
});
