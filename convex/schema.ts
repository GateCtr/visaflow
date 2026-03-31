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
  screenshotStorageId: v.optional(v.string()),
});

const slotBookingRefs = v.object({
  ds160Confirmation: v.optional(v.string()),
  mrvReceiptNumber: v.optional(v.string()),
  sevisId: v.optional(v.string()),
  petitionReceiptNumber: v.optional(v.string()),
  petitionerName: v.optional(v.string()),
  vfsRefNumber: v.optional(v.string()),
});

const hunterConfig = v.object({
  embassyUsername: v.string(),
  embassyPassword: v.string(),
  isActive: v.boolean(),
  twoCaptchaApiKey: v.optional(v.string()),
  lastCheckAt: v.optional(v.number()),
  checkCount: v.optional(v.number()),
  lastResult: v.optional(v.string()),
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
    successModel: v.optional(v.string()),
    visaDocumentStorageId: v.optional(v.string()),
    servicePackage: v.optional(v.union(
      v.literal("full_service"),
      v.literal("slot_only"),
      v.literal("dossier_only")
    )),
    slotUrgencyTier: v.optional(v.union(
      v.literal("standard"),
      v.literal("prioritaire"),
      v.literal("urgent"),
      v.literal("tres_urgent")
    )),
    slotBookingRefs: v.optional(slotBookingRefs),
    hunterConfig: v.optional(hunterConfig),
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

  documents: defineTable({
    applicationId: v.id("applications"),
    docKey: v.string(),
    label: v.string(),
    storageId: v.string(),
    uploadedBy: v.string(),
    uploadedAt: v.number(),
    verifiedByAdmin: v.boolean(),
    isAdminUpload: v.optional(v.boolean()),
    adminNote: v.optional(v.string()),
  })
    .index("by_application", ["applicationId"])
    .index("by_application_key", ["applicationId", "docKey"]),
});
